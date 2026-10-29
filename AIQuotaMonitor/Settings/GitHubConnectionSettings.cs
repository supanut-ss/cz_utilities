using System.Text.Json;

namespace AIQuotaMonitor.Settings;

public sealed record GitHubConnectionSettings(string UserName)
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AIQuotaMonitor", "github-connection.json");

    public static GitHubConnectionSettings? Load()
    {
        if (!File.Exists(FilePath)) return null;
        try { return JsonSerializer.Deserialize<GitHubConnectionSettings>(File.ReadAllText(FilePath)); }
        catch (JsonException) { return null; }
        catch (IOException) { return null; }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
    }

    public static void Delete()
    {
        if (File.Exists(FilePath)) File.Delete(FilePath);
    }
}
