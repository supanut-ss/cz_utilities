using System.Net.Http.Headers;
using System.Text.Json;
using AIQuotaMonitor.Models;
using AIQuotaMonitor.Security;

namespace AIQuotaMonitor.Providers;

public sealed class OpenAiUsageProvider : IQuotaProvider
{
    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(15) };
    public const string CredentialId = "openai-admin";
    public string Id => "openai-api";

    public async Task<IReadOnlyList<QuotaSnapshot>> RefreshAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var key = WindowsCredentialStore.Read(CredentialId);
        if (string.IsNullOrWhiteSpace(key))
            return [Snapshot(null, now, ProviderState.Disconnected, "Admin API key not connected")];

        try
        {
            var monthStart = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);
            var total = 0L;
            string? page = null;
            do
            {
                var url = "https://api.openai.com/v1/organization/usage/completions" +
                    $"?start_time={monthStart.ToUnixTimeSeconds()}&end_time={now.ToUnixTimeSeconds()}&bucket_width=1d&limit=31" +
                    (page is null ? "" : "&page=" + Uri.EscapeDataString(page));
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                using var response = await Client.SendAsync(request, cancellationToken);
                if (!response.IsSuccessStatusCode)
                    return [Snapshot(null, now, ProviderState.Error,
                        $"OpenAI API returned HTTP {(int)response.StatusCode}")];

                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
                using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
                var root = document.RootElement;
                foreach (var bucket in root.GetProperty("data").EnumerateArray())
                foreach (var result in bucket.GetProperty("results").EnumerateArray())
                {
                    total += result.GetProperty("input_tokens").GetInt64();
                    total += result.GetProperty("output_tokens").GetInt64();
                }
                page = root.TryGetProperty("has_more", out var hasMore) && hasMore.GetBoolean() &&
                    root.TryGetProperty("next_page", out var nextPage) && nextPage.ValueKind == JsonValueKind.String
                    ? nextPage.GetString() : null;
            } while (page is not null);

            return [Snapshot(total, now, ProviderState.Connected, "API usage; no quota limit supplied")];
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return [Snapshot(null, now, ProviderState.Error, "OpenAI API timed out")];
        }
        catch (HttpRequestException)
        {
            return [Snapshot(null, now, ProviderState.Error, "OpenAI API connection failed")];
        }
        catch (JsonException)
        {
            return [Snapshot(null, now, ProviderState.Error, "OpenAI API response could not be read")];
        }
    }

    private static QuotaSnapshot Snapshot(long? used, DateTimeOffset now, ProviderState state, string message) =>
        new("openai-api", "OpenAI API", "Organization", "Tokens used this month",
            used, null, "tokens", null, now, ValueSource.Provider, state, message);
}
