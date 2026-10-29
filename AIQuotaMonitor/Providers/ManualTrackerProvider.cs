using AIQuotaMonitor.Models;
using AIQuotaMonitor.Settings;

namespace AIQuotaMonitor.Providers;

public sealed class ManualTrackerProvider : IQuotaProvider
{
    public string Id => "manual";

    public Task<IReadOnlyList<QuotaSnapshot>> RefreshAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = DateTimeOffset.Now;
        IReadOnlyList<QuotaSnapshot> snapshots = ManualTrackerStore.Load()
            .Select(item => new QuotaSnapshot(item.Id, item.ServiceName, "Manual entry",
                "Reset schedule", null, null, "", item.ResetsAt, now,
                ValueSource.Manual, ProviderState.Connected,
                "Reset time entered by user; quota remaining unknown"))
            .ToList();
        return Task.FromResult(snapshots);
    }
}
