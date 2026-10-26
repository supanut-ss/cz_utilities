using System.Diagnostics;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LibreHardwareMonitor.Hardware;

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
            while (!_cts.IsCancellationRequested)
            {
                var hardware = new List<object>();
                foreach (var hw in computer.Hardware) Collect(hw, null, hardware);
                Publish("sensors", JsonSerializer.Serialize(new { admin = IsAdmin, pawnIo = hasPawnIo, hardware }));
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

    private static void Collect(IHardware hw, string? parent, List<object> output)
    {
        try { hw.Update(); } catch { return; }

        var sensors = hw.Sensors
            .Where(s => WantedSensors.Contains(s.SensorType) && s.Value is float v && !float.IsNaN(v))
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
