using System.Text.Json;

namespace AIQuotaMonitor.Settings;

public sealed record AppSettings(
    bool StartMinimized = false,
    bool ShowOverlayOnLaunch = false,
    bool OverlayTopMost = true,
    bool NotificationsEnabled = true,
    int NotifyBeforeMinutes = 15,
    int RefreshMinutes = 5,
    int? OverlayX = null,
    int? OverlayY = null)
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AIQuotaMonitor", "settings.json");

    public static AppSettings Load()
    {
        if (!File.Exists(FilePath)) return new AppSettings();
        try
        {
            return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new AppSettings();
        }
        catch (JsonException) { return new AppSettings(); }
        catch (IOException) { return new AppSettings(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var temporaryPath = FilePath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(this));
        File.Move(temporaryPath, FilePath, true);
    }
}
