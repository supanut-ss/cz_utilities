namespace HWMonitor;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        // PawnIO must be present before LibreHardwareMonitor opens its devices
        if (!PawnIo.EnsureInstalled()) return;
        Application.Run(new MainForm());
    }
}
