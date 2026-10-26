namespace HWMonitor;

internal static class Program
{
    // Second launches (e.g. double-click while the logon task already started it) signal the first instance to show
    private const string MutexName = @"Local\HWMonitor.SingleInstance";
    private const string ShowEventName = @"Local\HWMonitor.Show";

    [STAThread]
    private static void Main(string[] args)
    {
        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            if (EventWaitHandle.TryOpenExisting(ShowEventName, out var show)) using (show) show.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        // PawnIO must be present before LibreHardwareMonitor opens its devices
        if (!PawnIo.EnsureInstalled()) return;

        var startInTray = args.Contains(StartupTask.TrayArgument, StringComparer.OrdinalIgnoreCase);
        using var showRequested = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        Application.Run(new MainForm(startInTray, showRequested));
    }
}
