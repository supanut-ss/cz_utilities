// Streams temperature / fan / power sensors from LibreHardwareMonitor as one JSON line per interval.
using System.Security.Principal;
using System.Text.Json;
using LibreHardwareMonitor.Hardware;
using Microsoft.Win32;

var intervalMs = args.Length > 0 && int.TryParse(args[0], out var ms) ? ms : 1000;

var isAdmin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
// LibreHardwareMonitor 0.9.6+ reads CPU MSRs and Super I/O chips through the PawnIO driver
var hasPawnIo = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\PawnIO") is not null;

var computer = new Computer
{
    IsCpuEnabled = true,
    IsGpuEnabled = true,
    IsMotherboardEnabled = true,
    IsStorageEnabled = true,
    IsControllerEnabled = true,
};
computer.Open();

var wanted = new HashSet<SensorType> { SensorType.Temperature, SensorType.Fan, SensorType.Control, SensorType.Power };
var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };

AppDomain.CurrentDomain.ProcessExit += (_, _) => computer.Close();

while (true)
{
    var hardware = new List<object>();
    foreach (var hw in computer.Hardware) Collect(hw, null);

    stdout.WriteLine(JsonSerializer.Serialize(new { admin = isAdmin, pawnIo = hasPawnIo, hardware }));
    Thread.Sleep(intervalMs);

    void Collect(IHardware hw, string? parent)
    {
        try { hw.Update(); } catch { return; }

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
        {
            hardware.Add(new
            {
                id = hw.Identifier.ToString(),
                type = hw.HardwareType.ToString(),
                name = hw.Name,
                parent,
                sensors,
            });
        }

        // Super I/O chips (motherboard fans / temps) are sub-hardware of the motherboard
        foreach (var sub in hw.SubHardware) Collect(sub, hw.Name);
    }
}
