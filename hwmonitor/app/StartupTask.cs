using System.Diagnostics;
using System.Security.Principal;
using System.Text;
using System.Xml.Linq;

namespace HWMonitor;

/// <summary>
/// "Start with Windows" via a Task Scheduler logon task with highest privileges.
/// A Run-key entry would show a UAC prompt at every logon because the app requires admin; a task does not.
/// Creating or deleting the task needs admin rights, which the app always has (see app.manifest).
/// </summary>
internal static class StartupTask
{
    private const string TaskName = "HW Monitor";
    private static readonly XNamespace Ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";

    public const string TrayArgument = "--tray";

    /// <summary>Path of the exe the task starts, or null when no task exists.</summary>
    public static string? RegisteredPath()
    {
        var (exitCode, output) = RunSchtasks("/Query", "/TN", TaskName, "/XML");
        if (exitCode != 0) return null;
        try
        {
            return XDocument.Parse(output).Descendants(Ns + "Command").FirstOrDefault()?.Value;
        }
        catch (System.Xml.XmlException)
        {
            return null;
        }
    }

    public static bool IsEnabled => RegisteredPath() is not null;

    public static void Enable()
    {
        var user = WindowsIdentity.GetCurrent().Name;
        var xml = new XDocument(
            new XElement(Ns + "Task", new XAttribute("version", "1.2"),
                new XElement(Ns + "RegistrationInfo",
                    new XElement(Ns + "Description", "Starts HW Monitor in the system tray when you sign in.")),
                new XElement(Ns + "Triggers",
                    new XElement(Ns + "LogonTrigger",
                        new XElement(Ns + "Enabled", "true"),
                        new XElement(Ns + "UserId", user),
                        new XElement(Ns + "Delay", "PT10S"))),
                new XElement(Ns + "Principals",
                    new XElement(Ns + "Principal", new XAttribute("id", "Author"),
                        new XElement(Ns + "UserId", user),
                        new XElement(Ns + "LogonType", "InteractiveToken"),
                        new XElement(Ns + "RunLevel", "HighestAvailable"))),
                new XElement(Ns + "Settings",
                    new XElement(Ns + "MultipleInstancesPolicy", "IgnoreNew"),
                    new XElement(Ns + "DisallowStartIfOnBatteries", "false"),
                    new XElement(Ns + "StopIfGoingOnBatteries", "false"),
                    new XElement(Ns + "ExecutionTimeLimit", "PT0S"),
                    new XElement(Ns + "Priority", "7")),
                new XElement(Ns + "Actions", new XAttribute("Context", "Author"),
                    new XElement(Ns + "Exec",
                        new XElement(Ns + "Command", Environment.ProcessPath),
                        new XElement(Ns + "Arguments", TrayArgument)))));

        // schtasks /XML expects a UTF-16 file
        var file = Path.Combine(Path.GetTempPath(), $"hwmonitor-task-{Guid.NewGuid():N}.xml");
        try
        {
            File.WriteAllText(file, xml.Declaration + xml.ToString(), Encoding.Unicode);
            var (exitCode, output) = RunSchtasks("/Create", "/TN", TaskName, "/XML", file, "/F");
            if (exitCode != 0) throw new InvalidOperationException(output.Trim());
        }
        finally
        {
            File.Delete(file);
        }
    }

    public static void Disable()
    {
        var (exitCode, output) = RunSchtasks("/Delete", "/TN", TaskName, "/F");
        if (exitCode != 0 && IsEnabled) throw new InvalidOperationException(output.Trim());
    }

    /// <summary>Re-points an existing task at this exe if the app was moved since it was registered.</summary>
    public static void RepairPathIfMoved()
    {
        var path = RegisteredPath();
        if (path is not null && !string.Equals(path, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase))
            Enable();
    }

    private static (int ExitCode, string Output) RunSchtasks(params string[] args)
    {
        var psi = new ProcessStartInfo("schtasks.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        using var proc = Process.Start(psi)!;
        var stdout = proc.StandardOutput.ReadToEndAsync();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        return (proc.ExitCode, stdout.Result + stderr);
    }
}
