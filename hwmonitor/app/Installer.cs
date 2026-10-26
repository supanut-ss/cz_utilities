using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using Microsoft.Win32;

namespace HWMonitor;

/// <summary>
/// Built-in installer: "HWMonitor.exe --install" copies the exe to Program Files, adds a Start menu shortcut and an
/// "Apps &amp; features" entry; "--uninstall" removes them. No separate setup tool is needed, which keeps the
/// standalone build a single file. The app always runs elevated (see app.manifest), so HKLM and Program Files are writable.
/// </summary>
internal static class Installer
{
    public const string InstallArgument = "--install";
    public const string UninstallArgument = "--uninstall";
    private const string DirArgumentPrefix = "--install-dir=";

    private const string AppName = "HW Monitor";
    private const string ExeName = "HWMonitor.exe";
    private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\HWMonitor";

    private static string ShortcutPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), AppName + ".lnk");

    /// <summary>Handles install/uninstall switches. Returns an exit code, or null when the arguments are not for the installer.</summary>
    public static int? TryRun(string[] args)
    {
        var install = args.Contains(InstallArgument, StringComparer.OrdinalIgnoreCase);
        var uninstall = args.Contains(UninstallArgument, StringComparer.OrdinalIgnoreCase);
        if (!install && !uninstall) return null;

        try
        {
            if (uninstall) return Uninstall();
            var dirArgument = args.FirstOrDefault(a => a.StartsWith(DirArgumentPrefix, StringComparison.OrdinalIgnoreCase));
            var dir = dirArgument is null
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), AppName)
                : Path.GetFullPath(dirArgument[DirArgumentPrefix.Length..].Trim('"'));
            return Install(dir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception)
        {
            MessageBox.Show($"{(uninstall ? "Uninstall" : "Install")} failed.\n\n{ex.Message}", AppName,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static int Install(string dir)
    {
        var source = Environment.ProcessPath!;
        var target = Path.Combine(dir, ExeName);

        StopOtherInstances(); // an installed copy that is running holds its exe open, which blocks upgrades
        Directory.CreateDirectory(dir);
        if (!string.Equals(Path.GetFullPath(source), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
            File.Copy(source, target, overwrite: true);

        CreateShortcut(target, dir);

        using (var key = Registry.LocalMachine.CreateSubKey(UninstallKey))
        {
            var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";
            key.SetValue("DisplayName", AppName);
            key.SetValue("DisplayVersion", version);
            key.SetValue("Publisher", "CZ Utilities");
            key.SetValue("DisplayIcon", target);
            key.SetValue("InstallLocation", dir);
            key.SetValue("UninstallString", $"\"{target}\" {UninstallArgument}");
            key.SetValue("EstimatedSize", (int)(new FileInfo(target).Length / 1024), RegistryValueKind.DWord);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }

        Process.Start(new ProcessStartInfo(target) { UseShellExecute = true, WorkingDirectory = dir });
        return 0;
    }

    private static int Uninstall()
    {
        var self = Environment.ProcessPath!;
        var installDir = (string?)Registry.LocalMachine.OpenSubKey(UninstallKey)?.GetValue("InstallLocation");
        if (MessageBox.Show($"Remove {AppName} from this PC?\n\nIts start-up task, Start menu shortcut and saved settings are removed too.",
                AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            return 0;

        StopOtherInstances();
        try { StartupTask.Disable(); } catch (InvalidOperationException) { /* no task, or Task Scheduler unavailable */ }
        if (File.Exists(ShortcutPath)) File.Delete(ShortcutPath);
        Registry.LocalMachine.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false);

        DeleteUserData();

        // The running exe cannot delete itself; hand the last step to a short-lived cmd. Only the exe and an
        // empty folder are removed, and only when it is the registered install location, never an arbitrary folder.
        var selfDir = Path.GetDirectoryName(self)!;
        if (installDir is not null && string.Equals(Path.GetFullPath(installDir), Path.GetFullPath(selfDir), StringComparison.OrdinalIgnoreCase))
        {
            // Arguments (not ArgumentList): cmd does not understand the \" escaping that ArgumentList would add
            Process.Start(new ProcessStartInfo("cmd.exe")
            {
                Arguments = $"/c ping 127.0.0.1 -n 3 >nul & del /f /q \"{self}\" & rmdir \"{selfDir}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
            });
        }
        return 0;
    }

    // WebView2's helper processes can keep the profile open for a moment after the app is gone; a leftover
    // folder is harmless, so retry briefly and then give up instead of failing the uninstall
    private static void DeleteUserData()
    {
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HWMonitor");
        for (var attempt = 0; attempt < 10 && Directory.Exists(data); attempt++)
        {
            try { Directory.Delete(data, recursive: true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Thread.Sleep(500); }
        }
    }

    private static void StopOtherInstances()
    {
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName)))
        {
            using (process)
            {
                if (process.Id == Environment.ProcessId) continue;
                try
                {
                    process.Kill(entireProcessTree: true); // includes WebView2 and the PowerShell collector
                    process.WaitForExit(5000);
                }
                catch (Exception ex) when (ex is InvalidOperationException or Win32Exception) { /* already gone */ }
            }
        }
    }

    // WScript.Shell is the simplest way to write a .lnk without a native interop declaration
    private static void CreateShortcut(string target, string workingDirectory)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new IOException("Windows Script Host is not available to create the shortcut.");
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic link = shell.CreateShortcut(ShortcutPath);
        link.TargetPath = target;
        link.WorkingDirectory = workingDirectory;
        link.IconLocation = target + ",0";
        link.Description = "Hardware monitor with live sensors and specs";
        link.Save();
    }
}
