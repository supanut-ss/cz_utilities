using System.Diagnostics;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiskInfoToolkit;
using DiskInfoToolkit.Enums.Interop;
using DiskInfoToolkit.Interop.Enums;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.Hardware.Storage;

namespace HWMonitor;

/// <summary>
/// Runs the data sources and reports each sample as (event, json):
/// "live" from ps/live.ps1, "sensors" from LibreHardwareMonitor, specs on demand from ps/specs.ps1.
/// </summary>
internal sealed class Collectors : IDisposable
{
    public static readonly bool IsAdmin =
        new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    private static readonly HashSet<SensorType> WantedSensors =
        [SensorType.Temperature, SensorType.Fan, SensorType.Control, SensorType.Power];

    // Drives also report wear (Level), usage (Data, in GB) and power-on hours (Factor)
    private static readonly HashSet<SensorType> StorageSensors =
        [.. WantedSensors, SensorType.Level, SensorType.Data, SensorType.Factor];

    private readonly Action<string, string> _post;
    private readonly Dictionary<string, string> _latest = [];
    private readonly CancellationTokenSource _cts = new();
    private readonly object _gate = new();
    private Task<string>? _specsTask;
    private Process? _liveProc;

    public Collectors(Action<string, string> post) => _post = post;

    public void Start()
    {
        StartLive();
        new Thread(SensorLoop) { IsBackground = true, Name = "LHM sensors" }.Start();
        new Thread(ProcessLoop) { IsBackground = true, Name = "Top processes" }.Start();
        _ = GetSpecsAsync(refresh: false); // warm the cache while the page loads
    }

    public KeyValuePair<string, string>[] Latest()
    {
        lock (_latest) return [.. _latest];
    }

    private void Publish(string evt, string json)
    {
        lock (_latest) _latest[evt] = json;
        _post(evt, json);
    }

    // ---------- Specs ----------

    public async Task<string> GetSpecsAsync(bool refresh)
    {
        Task<string> task;
        lock (_gate)
        {
            if (refresh || _specsTask is null || _specsTask.IsFaulted)
                _specsTask = Task.Run(() => RunScriptToEnd("specs.ps1"));
            task = _specsTask;
        }
        return WithFreshVolumes(await task);
    }

    // Free space changes while the app runs; specs are cached, so patch volumes on every request
    private static string WithFreshVolumes(string specsJson)
    {
        var root = JsonNode.Parse(specsJson)!;
        foreach (var disk in root["disks"]?.AsArray() ?? [])
        {
            foreach (var vol in disk?["volumes"]?.AsArray() ?? [])
            {
                try
                {
                    var drive = new DriveInfo((string)vol!["letter"]!);
                    vol["size"] = drive.TotalSize;
                    vol["free"] = drive.AvailableFreeSpace;
                }
                catch (IOException) { /* drive removed */ }
            }
        }
        return root.ToJsonString();
    }

    // ---------- PowerShell collectors ----------

    // Scripts are piped from embedded resources instead of written to disk,
    // so an elevated instance never executes a file another process could swap.
    private static Process StartScript(string name, string args)
    {
        var bootstrap = "[Console]::InputEncoding=[Text.Encoding]::UTF8;" +
                        "$s=[Console]::In.ReadToEnd();& ([scriptblock]::Create($s)) " + args;
        var psi = new ProcessStartInfo("powershell.exe")
        {
            ArgumentList = { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", bootstrap },
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
        };
        var proc = Process.Start(psi)!;
        using (var script = Assembly.GetExecutingAssembly().GetManifestResourceStream("ps/" + name)!)
        using (var reader = new StreamReader(script))
        {
            proc.StandardInput.Write(reader.ReadToEnd());
        }
        proc.StandardInput.Close();
        return proc;
    }

    private static string RunScriptToEnd(string name)
    {
        using var proc = StartScript(name, "");
        var output = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit();
        var json = output.Trim();
        if (!json.StartsWith('{')) throw new InvalidOperationException("Hardware scan returned no data.");
        return json;
    }

    private void StartLive()
    {
        if (_cts.IsCancellationRequested) return;
        var proc = StartScript("live.ps1", $"-IntervalMs 1000 -ParentPid {Environment.ProcessId}");
        proc.EnableRaisingEvents = true;
        proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data?.StartsWith('{') == true) Publish("live", e.Data);
        };
        proc.Exited += (_, _) =>
        {
            // Keep the collector alive if PowerShell dies
            if (!_cts.IsCancellationRequested) Task.Delay(3000).ContinueWith(_ => StartLive());
        };
        proc.BeginOutputReadLine();
        _liveProc = proc;
    }

    // ---------- Top processes ----------

    private const int TopCount = 8;
    private const int ProcessIntervalMs = 3000;
    private volatile bool _watchProcesses = true;

    /// <summary>Sampling every process is not free, so MainForm turns it off while the window is hidden in the tray.</summary>
    public bool WatchProcesses
    {
        get => _watchProcesses;
        set => _watchProcesses = value;
    }

    private void ProcessLoop()
    {
        var previous = new Dictionary<int, TimeSpan>();
        var lastSample = Stopwatch.GetTimestamp();

        while (!_cts.IsCancellationRequested)
        {
            if (!_watchProcesses)
            {
                previous.Clear(); // stale after a pause; the next sample then starts from zero
                _cts.Token.WaitHandle.WaitOne(500);
                continue;
            }

            var now = Stopwatch.GetTimestamp();
            var elapsed = Stopwatch.GetElapsedTime(lastSample, now).TotalSeconds;
            lastSample = now;

            var current = new Dictionary<int, TimeSpan>();
            var groups = new Dictionary<string, (double Cpu, long Bytes, int Count)>(StringComparer.OrdinalIgnoreCase);
            foreach (var process in Process.GetProcesses())
            {
                using (process)
                {
                    if (process.Id == 0) continue; // System Idle Process would read as ~100% CPU
                    double cpu = 0;
                    long bytes = 0;
                    try { bytes = process.WorkingSet64; }
                    catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }
                    try
                    {
                        var time = process.TotalProcessorTime;
                        current[process.Id] = time;
                        if (previous.TryGetValue(process.Id, out var before) && elapsed > 0)
                            cpu = Math.Max(0, (time - before).TotalSeconds) / elapsed / Environment.ProcessorCount * 100;
                    }
                    catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }

                    var name = process.ProcessName;
                    groups[name] = groups.TryGetValue(name, out var g)
                        ? (g.Cpu + cpu, g.Bytes + bytes, g.Count + 1)
                        : (cpu, bytes, 1);
                }
            }
            previous = current;

            Publish("procs", JsonSerializer.Serialize(new
            {
                cpu = groups.OrderByDescending(g => g.Value.Cpu).Take(TopCount)
                    .Select(g => new { name = g.Key, value = Math.Round(g.Value.Cpu, 1), count = g.Value.Count }),
                mem = groups.OrderByDescending(g => g.Value.Bytes).Take(TopCount)
                    .Select(g => new { name = g.Key, bytes = g.Value.Bytes, count = g.Value.Count }),
            }));

            _cts.Token.WaitHandle.WaitOne(ProcessIntervalMs);
        }
    }

    // ---------- LibreHardwareMonitor ----------

    private void SensorLoop()
    {
        var hasPawnIo = PawnIo.IsInstalled;
        var computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMotherboardEnabled = true,
            IsStorageEnabled = true,
            IsControllerEnabled = true,
        };

        try
        {
            computer.Open();
            for (var tick = 0; !_cts.IsCancellationRequested; tick++)
            {
                var hardware = new List<object>();
                foreach (var hw in computer.Hardware) Collect(hw, null, hardware);
                Publish("sensors", JsonSerializer.Serialize(new { admin = IsAdmin, pawnIo = hasPawnIo, hardware }));
                // SMART tables change slowly, so they go out every 10 s instead of every second
                if (tick % 10 == 0) PublishSmart(computer);
                _cts.Token.WaitHandle.WaitOne(1000);
            }
        }
        catch (Exception ex)
        {
            Publish("sensors", JsonSerializer.Serialize(new { admin = IsAdmin, pawnIo = hasPawnIo, hardware = Array.Empty<object>(), error = ex.Message }));
        }
        finally
        {
            computer.Close();
        }
    }

    // ---------- SMART tables (via DiskInfoToolkit, which LibreHardwareMonitor uses for drives) ----------

    private void PublishSmart(Computer computer)
    {
        var drives = new List<object>();
        foreach (var hw in computer.Hardware)
        {
            if (hw is not StorageDevice { Storage: { Smart: { } smart } storage }) continue;
            try
            {
                var attributes = smart.SmartAttributes
                    // NVMe drives list 8 temperature sensors but fill only the ones they have
                    .Where(a => !(storage.IsNVMe && a.Info?.Type.ToString().StartsWith("TemperatureSensor") == true && a.Attribute.RawValueULong == 0))
                    .Select(SmartRow).ToList();
                drives.Add(new
                {
                    name = hw.Name,
                    status = smart.DiskStatus.ToString(), // Good / Caution / Bad / Unknown, same rules as CrystalDiskInfo
                    ssd = storage.IsSSD,
                    nvme = storage.IsNVMe,
                    bus = storage.BusType.ToString().Replace("BusType", ""),
                    transfer = storage.ATAInfo?.TransferMode.ToString().Replace("TransferMode", ""),
                    attributes,
                });
            }
            catch (Exception ex) when (ex is InvalidOperationException or NullReferenceException or ArgumentException)
            {
                // A drive that cannot be read just has no SMART table
            }
        }
        Publish("smart", JsonSerializer.Serialize(new { drives }));
    }

    private static object SmartRow(DiskInfoToolkit.SmartAttribute attribute)
    {
        var s = attribute.Attribute;
        var raw = s.RawValueULong;
        var type = attribute.Info?.Type;
        // Temperature attributes count down from a vendor-chosen value, so "worst <= threshold" there is not a failure
        var isTemperature = type is SmartAttributeType.Temperature or SmartAttributeType.AirflowTemperature;
        var status = isTemperature || s.Threshold == 0 ? "ok"
            : s.CurrentValue <= s.Threshold ? "bad"
            : s.WorstValue <= s.Threshold ? "warn" // crossed the threshold in the past, fine now
            : "ok";
        return new
        {
            id = s.ID,
            type = type?.ToString(),
            name = string.IsNullOrWhiteSpace(attribute.Info?.Name) ? $"Attribute {s.ID:X2}" : attribute.Info!.Name,
            current = (int)s.CurrentValue,
            worst = (int)s.WorstValue,
            threshold = (int)s.Threshold,
            raw,
            rawHex = raw.ToString("X12"),
            status,
        };
    }

    private static void Collect(IHardware hw, string? parent, List<object> output)
    {
        try { hw.Update(); } catch { return; }

        var wanted = hw.HardwareType == HardwareType.Storage ? StorageSensors : WantedSensors;
        var sensors = hw.Sensors
            .Where(s => wanted.Contains(s.SensorType) && s.Value is float v && !float.IsNaN(v))
            .Select(s => new
            {
                type = s.SensorType.ToString(),
                name = s.Name,
                value = Math.Round(s.Value!.Value, 1),
                max = s.Max is float m && !float.IsNaN(m) ? Math.Round(m, 1) : (double?)null,
            })
            .ToList();

        if (sensors.Count > 0)
            output.Add(new { id = hw.Identifier.ToString(), type = hw.HardwareType.ToString(), name = hw.Name, parent, sensors });

        // Super I/O chips (motherboard fans / temps) are sub-hardware of the motherboard
        foreach (var sub in hw.SubHardware) Collect(sub, hw.Name, output);
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _liveProc?.Kill(entireProcessTree: true); } catch { /* already gone */ }
    }
}
