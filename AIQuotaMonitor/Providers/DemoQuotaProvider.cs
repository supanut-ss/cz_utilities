using AIQuotaMonitor.Models;

namespace AIQuotaMonitor.Providers;

public sealed class DemoQuotaProvider : IQuotaProvider
{
    public string Id => "demo";

    public Task<IReadOnlyList<QuotaSnapshot>> RefreshAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = DateTimeOffset.Now;
        IReadOnlyList<QuotaSnapshot> snapshots =
        [
            new("demo-example", "Example provider (demo)", "Demo account", "Tokens", 72_000, 100_000,
                "tokens", now.AddHours(3), now, ValueSource.Demo, ProviderState.Connected),
            new("demo-unavailable", "Example unavailable (demo)", "Demo account", "Session allowance",
                null, null, "", null, now, ValueSource.Demo, ProviderState.Unavailable,
                "No supported quota connection is configured")
        ];
        return Task.FromResult(snapshots);
    }
}
