using AIQuotaMonitor.Models;

namespace AIQuotaMonitor.Providers;

public interface IQuotaProvider
{
    string Id { get; }
    Task<IReadOnlyList<QuotaSnapshot>> RefreshAsync(CancellationToken cancellationToken);
}
