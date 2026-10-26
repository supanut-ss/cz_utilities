namespace HWMonitor;

internal static class Program
{
    // Second launches (e.g. double-click while the logon task already started it) signal the first instance to show
    private const string MutexName = @"Local\HWMonitor.SingleInstance";
    private const string ShowEventName = @"Local\HWMonitor.Show";

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // --install / --uninstall run before the single-instance check: they have to stop a running copy
        if (Installer.TryRun(args) is { } installerExitCode) return installerExitCode;

        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            if (EventWaitHandle.TryOpenExisting(ShowEventName, out var show)) using (show) show.Set();
            return 0;
        }

        // PawnIO must be present before LibreHardwareMonitor opens its devices
        if (!PawnIo.EnsureInstalled()) return 0;

        var startInTray = args.Contains(StartupTask.TrayArgument, StringComparer.OrdinalIgnoreCase);
        using var showRequested = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        Application.Run(new MainForm(startInTray, showRequested));
        return 0;
    }
}
