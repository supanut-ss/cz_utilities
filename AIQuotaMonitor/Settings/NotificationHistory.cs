using System.Text.Json;

namespace AIQuotaMonitor.Settings;

public static class NotificationHistory
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AIQuotaMonitor", "notification-history.json");

    public static HashSet<string> Load()
    {
        if (!File.Exists(FilePath)) return [];
        try { return JsonSerializer.Deserialize<HashSet<string>>(File.ReadAllText(FilePath)) ?? []; }
        catch (JsonException) { return []; }
        catch (IOException) { return []; }
    }

    public static void Save(HashSet<string> keys)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var temporaryPath = FilePath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(keys));
        File.Move(temporaryPath, FilePath, true);
    }
}
