using AIQuotaMonitor.Models;

namespace AIQuotaMonitor;

internal sealed class OverlayForm : Form
{
    private readonly Label _summary;
    private Point? _dragOrigin;
    public event EventHandler? HideRequested;
    public event EventHandler? PositionChanged;
    public event EventHandler? ResetPositionRequested;
    public event EventHandler? OpenMainRequested;

    public OverlayForm()
    {
        Text = "AI Quota Overlay";
        Width = 340;
        Height = 190;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = UiPalette.Surface;
        ForeColor = UiPalette.Foreground;
        Opacity = 0.97;

        var title = new Label
        {
            Text = "AI Quota Monitor",
            Font = UiPalette.HeadingFont,
            Left = 14, Top = 10, Width = 260, Height = 25,
            ForeColor = UiPalette.Foreground
        };
        var close = new Button
        {
            Text = "ปิด", Left = 292, Top = 7, Width = 38, Height = 30,
            FlatStyle = FlatStyle.Flat, ForeColor = UiPalette.Foreground,
            BackColor = UiPalette.SurfaceRaised, AccessibleName = "ปิดโอเวอร์เลย์"
        };
        close.FlatAppearance.BorderSize = 1;
        close.FlatAppearance.BorderColor = UiPalette.Border;
        close.Click += (_, _) => HideRequested?.Invoke(this, EventArgs.Empty);
        _summary = new Label
        {
            Text = "ยังไม่มีรายการติดตาม",
            Left = 14, Top = 48, Width = 312, Height = 126,
            Font = UiPalette.BodyFont, ForeColor = UiPalette.SecondaryText
        };
        Controls.AddRange([title, close, _summary]);

        var menu = new ContextMenuStrip();
        menu.Items.Add("เปิดหน้าหลัก", null, (_, _) => OpenMainRequested?.Invoke(this, EventArgs.Empty));
        menu.Items.Add("คืนตำแหน่งเริ่มต้น", null, (_, _) => ResetPositionRequested?.Invoke(this, EventArgs.Empty));
        menu.Items.Add("ซ่อนโอเวอร์เลย์", null, (_, _) => HideRequested?.Invoke(this, EventArgs.Empty));
        ContextMenuStrip = menu;
        title.ContextMenuStrip = menu;
        _summary.ContextMenuStrip = menu;

        MouseDown += StartDrag;
        MouseMove += MoveDrag;
        MouseUp += EndDrag;
        title.MouseDown += StartDrag;
        title.MouseMove += MoveDrag;
        title.MouseUp += EndDrag;
    }

    public void ShowSnapshots(IReadOnlyList<QuotaSnapshot> snapshots)
    {
        if (snapshots.Count == 0)
        {
            _summary.Text = "ยังไม่มีรายการ\nเพิ่มเวลารีเซ็ตได้จากหน้าหลัก";
            return;
        }
        var lines = snapshots.Take(4).Select(snapshot =>
        {
            if (snapshot.ResetsAt is { } reset)
            {
                var remaining = reset - DateTimeOffset.Now;
                var time = remaining <= TimeSpan.Zero ? "ถึงเวลารีเซ็ตแล้ว" :
                    remaining.TotalHours >= 1 ? $"อีก {remaining.TotalHours:0} ชม." :
                    $"อีก {Math.Max(1, remaining.TotalMinutes):0} นาที";
                var source = snapshot.Source == ValueSource.Manual ? " (กรอกเอง)" : "";
                return $"{snapshot.ProviderName}: {time}{source}";
            }
            if (snapshot.Used is { } used)
                return $"{snapshot.ProviderName}: {used:N0} {snapshot.Unit} used";
            return $"{snapshot.ProviderName}: ยังไม่มีข้อมูล";
        });
        _summary.Text = string.Join(Environment.NewLine, lines) +
            (snapshots.Count > 4 ? $"{Environment.NewLine}+{snapshots.Count - 4} more" : "");
    }

    private void StartDrag(object? sender, MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) _dragOrigin = Cursor.Position;
    }

    private void MoveDrag(object? sender, MouseEventArgs e)
    {
        if (_dragOrigin is not { } origin || e.Button != MouseButtons.Left) return;
        var cursor = Cursor.Position;
        Location = new Point(Left + cursor.X - origin.X, Top + cursor.Y - origin.Y);
        _dragOrigin = cursor;
    }

    private void EndDrag(object? sender, MouseEventArgs e)
    {
        if (_dragOrigin is null) return;
        _dragOrigin = null;
        PositionChanged?.Invoke(this, EventArgs.Empty);
    }
}
