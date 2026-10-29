using System.Net.Http.Headers;
using System.Text.Json;
using AIQuotaMonitor.Models;
using AIQuotaMonitor.Security;
using AIQuotaMonitor.Settings;

namespace AIQuotaMonitor.Providers;

public sealed class GitHubCopilotProvider : IQuotaProvider
{
    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(15) };
    public const string CredentialId = "github-copilot";
    public string Id => "github-copilot";

    public async Task<IReadOnlyList<QuotaSnapshot>> RefreshAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var settings = GitHubConnectionSettings.Load();
        var token = WindowsCredentialStore.Read(CredentialId);
        if (settings is null || string.IsNullOrWhiteSpace(token))
            return [Snapshot(null, now, ProviderState.Disconnected, "GitHub not connected")];

        try
        {
            var url = $"https://api.github.com/users/{Uri.EscapeDataString(settings.UserName)}/settings/billing/ai_credit/usage" +
                $"?year={now.Year}&month={now.Month}";
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
            request.Headers.UserAgent.ParseAdd("AIQuotaMonitor/0.1");
            request.Headers.Add("X-GitHub-Api-Version", "2026-03-10");
            using var response = await Client.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
                return [Snapshot(null, now, ProviderState.Error,
                    $"GitHub API returned HTTP {(int)response.StatusCode}")];

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            double used = 0;
            foreach (var item in document.RootElement.GetProperty("usageItems").EnumerateArray())
            {
                if (item.TryGetProperty("unitType", out var unit) && unit.GetString() == "ai-credits" &&
                    item.TryGetProperty("product", out var product) &&
                    product.GetString()?.Contains("Copilot", StringComparison.OrdinalIgnoreCase) == true)
                    used += item.GetProperty("grossQuantity").GetDouble();
            }
            return [Snapshot(used, now, ProviderState.Connected,
                "Personal AI credit usage; allowance not supplied")];
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return [Snapshot(null, now, ProviderState.Error, "GitHub API timed out")];
        }
        catch (HttpRequestException)
        {
            return [Snapshot(null, now, ProviderState.Error, "GitHub API connection failed")];
        }
        catch (JsonException)
        {
            return [Snapshot(null, now, ProviderState.Error, "GitHub API response could not be read")];
        }
    }

    private static QuotaSnapshot Snapshot(double? used, DateTimeOffset now, ProviderState state, string message) =>
        new("github-copilot", "GitHub Copilot", "Personal account", "AI credits used this month",
            used, null, "credits", null, now, ValueSource.Provider, state, message);
}
