using Microsoft.Win32;

namespace AIQuotaMonitor.Settings;

public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "AIQuotaMonitor";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) is string value &&
            value.Contains(Environment.ProcessPath ?? "", StringComparison.OrdinalIgnoreCase);
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true)
            ?? throw new InvalidOperationException("Windows startup settings are unavailable.");
        if (enabled)
            key.SetValue(ValueName, $"\"{Environment.ProcessPath}\"", RegistryValueKind.String);
        else
            key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
