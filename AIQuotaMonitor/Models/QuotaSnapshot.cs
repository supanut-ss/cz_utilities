namespace AIQuotaMonitor.Models;

public enum ProviderState { Connected, Disconnected, Unavailable, Error }
public enum ValueSource { Provider, Manual, Demo }

public sealed record QuotaSnapshot(
    string ProviderId,
    string ProviderName,
    string AccountLabel,
    string MetricName,
    double? Used,
    double? Limit,
    string Unit,
    DateTimeOffset? ResetsAt,
    DateTimeOffset ObservedAt,
    ValueSource Source,
    ProviderState State,
    string? Message = null)
{
    public double? Remaining => Limit.HasValue && Used.HasValue
        ? Math.Max(0, Limit.Value - Used.Value)
        : null;
}
