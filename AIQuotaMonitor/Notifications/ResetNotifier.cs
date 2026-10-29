using AIQuotaMonitor.Settings;

namespace AIQuotaMonitor.Notifications;

public sealed class ResetNotifier
{
    private readonly HashSet<string> _sent = NotificationHistory.Load();

    public void Check(
        IReadOnlyList<ManualTracker> trackers,
        int notifyBeforeMinutes,
        Action<string, string> notify)
    {
        var now = DateTimeOffset.Now;
        foreach (var tracker in trackers)
        {
            var remaining = tracker.ResetsAt - now;
            string? kind = null;
            string? body = null;
            if (remaining > TimeSpan.Zero && remaining <= TimeSpan.FromMinutes(notifyBeforeMinutes))
            {
                kind = "soon";
                body = $"Reset in {Math.Max(1, Math.Ceiling(remaining.TotalMinutes)):0} minutes (manual schedule).";
            }
            else if (remaining <= TimeSpan.Zero && remaining >= TimeSpan.FromHours(-1))
            {
                kind = "reached";
                body = "Your manually entered reset time has been reached.";
            }
            if (kind is null || body is null) continue;

            var key = $"{tracker.Id}:{tracker.ResetsAt.ToUnixTimeSeconds()}:{kind}";
            if (!_sent.Add(key)) continue;
            NotificationHistory.Save(_sent);
            notify(tracker.ServiceName, body);
        }
    }
}
