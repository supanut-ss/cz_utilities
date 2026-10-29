using System.Text.Json;

namespace AIQuotaMonitor.Settings;

public sealed record ManualTracker(string Id, string ServiceName, DateTimeOffset ResetsAt);

public static class ManualTrackerStore
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AIQuotaMonitor", "manual-trackers.json");

    public static List<ManualTracker> Load()
    {
        if (!File.Exists(FilePath)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<ManualTracker>>(File.ReadAllText(FilePath)) ?? [];
        }
        catch (JsonException) { return []; }
        catch (IOException) { return []; }
    }

    public static void Save(IReadOnlyList<ManualTracker> trackers)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var temporaryPath = FilePath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(trackers));
        File.Move(temporaryPath, FilePath, true);
    }
}
