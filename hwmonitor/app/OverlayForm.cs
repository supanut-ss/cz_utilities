using System.Globalization;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace HWMonitor;

/// <summary>
/// Single-line always-on-top bar pinned to the top centre of the screen, showing the selected live metrics.
/// Owner-drawn so the whole strip stays one row; value slots have fixed widths so it does not jitter.
/// </summary>
internal sealed class OverlayForm : Form
{
    private const string EmptyValue = "—";
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtCaption = 2;
    private const int CsDropShadow = 0x00020000;
    private const TextFormatFlags TextFlags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter;

    // Layout in logical (96 DPI) pixels
    private const int BarHeight = 28;
    private const int CornerRadius = 8;
    private const int EdgePadding = 10;
    private const int DotSize = 7;
    private const int CaptionGap = 5;
    private const int SegmentGap = 9;
    private const int CloseWidth = 24;
    private const int TopMargin = 6;

    private static readonly Color SurfaceColor = Color.FromArgb(15, 20, 27);
    private static readonly Color BorderColor = Color.FromArgb(52, 65, 79);
    private static readonly Color DividerColor = Color.FromArgb(40, 50, 62);
    private static readonly Color HoverColor = Color.FromArgb(45, 55, 68);
    private static readonly Color MutedColor = Color.FromArgb(139, 152, 167);
    private static readonly Color LiveColor = Color.FromArgb(74, 222, 128);
    private static readonly Color CpuColor = Color.FromArgb(56, 189, 248);
    private static readonly Color MemoryColor = Color.FromArgb(167, 139, 250);
    private static readonly Color GpuColor = Color.FromArgb(74, 222, 128);
    private static readonly Color DiskColor = Color.FromArgb(251, 191, 36);
    private static readonly Color TemperatureColor = Color.FromArgb(251, 146, 60);
    private static readonly Color FrameColor = Color.FromArgb(45, 212, 191);
    private static readonly Color WarningColor = Color.FromArgb(251, 191, 36);
    private static readonly Color CriticalColor = Color.FromArgb(248, 113, 113);

    // Template = widest expected value, used to reserve a fixed slot per metric
    private static readonly (string Key, string Caption, string Template)[] Metrics =
    [
        ("cpu", "CPU", "100% 9.99 GHz"),
        ("cpuTemp", "CPU TEMP", "100.0°C"),
        ("gpu", "GPU", "100%"),
        ("gpuTemp", "GPU TEMP", "100.0°C"),
        ("memory", "RAM", "99.9/99.9 GB"),
        ("memorySpeed", "RAM SPEED", "9999 MT/s"),
        ("vram", "VRAM", "99.9/99.9 GB"),
        ("fan", "FAN", "9999 RPM"),
        ("disk", "DISK", "100%"),
        ("fps", "FPS", "999"),
        ("frameTime", "FRAME", "99.99 ms"),
        ("low1", "1% LOW", "999"),
    ];

    private readonly Font _captionFont = new("Segoe UI", 7f, FontStyle.Bold);
    private readonly Font _valueFont = new("Consolas", 9.5f, FontStyle.Bold);
    private readonly Font _closeFont = new("Segoe UI", 11f);
    private readonly Dictionary<string, (string Text, Color Color)> _values = new(StringComparer.Ordinal);
    private readonly List<(string Key, string Caption, Rectangle CaptionRect, Rectangle ValueRect)> _segments = [];
    private readonly HashSet<string> _visibleMetrics = new(StringComparer.Ordinal);
    private readonly Rectangle _workingArea;
    private Rectangle _closeRect;
    private bool _closeHover;
    private bool _userMoved;

    private double? _cpuLoad;
    private double? _cpuFrequencyMHz;
    private double? _cpuTemperature;
    private double? _gpuLoad;
    private double? _gpuTemperature;
    private double? _memoryUsed;
    private double? _memoryTotal;
    private double? _memorySpeedMTs;
    private double? _vramUsed;
    private double? _vramTotal;
    private double? _fanRpm;
    private double? _diskActivity;
    private double? _fps;
    private double? _frameTimeMs;
    private double? _low1Fps;
    private string? _primaryGpuLuid;
    private string? _primaryGpuName;

    public OverlayForm(Rectangle workingArea)
    {
        _workingArea = workingArea;
        Text = "HW Monitor Overlay";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        Opacity = 0.94;
        BackColor = SurfaceColor;
        DoubleBuffered = true;
        Cursor = Cursors.SizeAll;

        ApplyConfig("{\"metrics\":[\"cpu\",\"cpuTemp\",\"gpu\",\"gpuTemp\",\"memory\",\"vram\",\"fps\",\"frameTime\",\"low1\"],\"opacity\":94}");
        FormClosing += (_, e) =>
        {
            if (e.CloseReason != CloseReason.UserClosing) return;
            e.Cancel = true;
            Hide();
        };
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ClassStyle |= CsDropShadow;
            return parameters;
        }
    }

    protected override bool ShowWithoutActivation => true; // never steal focus from a game

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Relayout();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        Relayout();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _captionFont.Dispose();
            _valueFont.Dispose();
            _closeFont.Dispose();
        }
        base.Dispose(disposing);
    }

    // ---------- Layout & painting ----------

    private int Px(int logical) => LogicalToDeviceUnits(logical);

    private void Relayout()
    {
        _segments.Clear();
        var height = Px(BarHeight);
        var x = Px(EdgePadding) + Px(DotSize) + Px(SegmentGap);

        foreach (var (key, caption, template) in Metrics.Where(m => _visibleMetrics.Contains(m.Key)))
        {
            if (_segments.Count > 0) x += Px(SegmentGap) * 2 + 1; // gap, divider, gap

            var captionWidth = TextRenderer.MeasureText(caption, _captionFont, Size.Empty, TextFlags).Width;
            var current = _values.TryGetValue(key, out var v) ? v.Text : EmptyValue;
            var valueWidth = Math.Max(
                TextRenderer.MeasureText(template, _valueFont, Size.Empty, TextFlags).Width,
                TextRenderer.MeasureText(current, _valueFont, Size.Empty, TextFlags).Width);

            var captionRect = new Rectangle(x, 0, captionWidth, height);
            var valueRect = new Rectangle(captionRect.Right + Px(CaptionGap), 0, valueWidth, height);
            _segments.Add((key, caption, captionRect, valueRect));
            x = valueRect.Right;
        }

        x += Px(SegmentGap);
        _closeRect = new Rectangle(x, (height - Px(20)) / 2, Px(CloseWidth), Px(20));
        var width = _closeRect.Right + Px(EdgePadding) / 2;

        if (ClientSize != new Size(width, height))
        {
            ClientSize = new Size(width, height);
            UpdateWindowRegion();
        }
        // Pinned to the top centre until the user drags it somewhere else
        if (!_userMoved)
            Location = new Point(_workingArea.Left + (_workingArea.Width - Width) / 2, _workingArea.Top + Px(TopMargin));
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var path = CreateRoundedPath(new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1), Px(CornerRadius)))
        using (var border = new Pen(BorderColor))
            g.DrawPath(border, path);

        // Live dot doubles as the drag handle
        var dot = Px(DotSize);
        using (var live = new SolidBrush(LiveColor))
            g.FillEllipse(live, Px(EdgePadding), (ClientSize.Height - dot) / 2, dot, dot);

        g.SmoothingMode = SmoothingMode.None;
        using var divider = new Pen(DividerColor);
        for (var i = 0; i < _segments.Count; i++)
        {
            var (key, caption, captionRect, valueRect) = _segments[i];
            if (i > 0)
            {
                var dx = captionRect.Left - Px(SegmentGap) - 1;
                g.DrawLine(divider, dx, Px(7), dx, ClientSize.Height - Px(7));
            }
            TextRenderer.DrawText(g, caption, _captionFont, captionRect, MutedColor, TextFlags | TextFormatFlags.Left);
            var (text, color) = _values.TryGetValue(key, out var v) ? v : (EmptyValue, MutedColor);
            TextRenderer.DrawText(g, text, _valueFont, valueRect, color, TextFlags | TextFormatFlags.Left);
        }

        if (_closeHover)
        {
            using var hover = new SolidBrush(HoverColor);
            g.FillRectangle(hover, _closeRect);
        }
        TextRenderer.DrawText(g, "×", _closeFont, _closeRect, MutedColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        if (_closeRect.Contains(e.Location))
        {
            Hide();
            return;
        }
        _userMoved = true;
        ReleaseCapture();
        SendMessage(Handle, WmNcLButtonDown, new IntPtr(HtCaption), IntPtr.Zero);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var hover = _closeRect.Contains(e.Location);
        if (hover == _closeHover) return;
        _closeHover = hover;
        Cursor = hover ? Cursors.Hand : Cursors.SizeAll;
        Invalidate(_closeRect);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (!_closeHover) return;
        _closeHover = false;
        Invalidate(_closeRect);
    }

    private void UpdateWindowRegion()
    {
        if (!IsHandleCreated) return;
        using var path = CreateRoundedPath(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height), Px(CornerRadius));
        var previousRegion = Region;
        Region = new Region(path);
        previousRegion?.Dispose();
    }

    private static GraphicsPath CreateRoundedPath(Rectangle bounds, int radius)
    {
        var diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int message, IntPtr wParam, IntPtr lParam);

    // ---------- Data ----------

    public void ApplySnapshot(string eventName, string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            switch (eventName)
            {
                case "specs":
                    ReadSpecs(root);
                    break;
                case "live":
                    ReadLive(root);
                    break;
                case "sensors":
                    ReadSensors(root);
                    break;
                case "game-metrics":
                    _fps = Number(root, "fps");
                    _frameTimeMs = Number(root, "frameTimeMs");
                    _low1Fps = Number(root, "low1Fps");
                    break;
                default:
                    return;
            }
            RefreshMetrics();
        }
        catch (JsonException)
        {
            // Ignore incomplete or unavailable readings and keep the last valid snapshot.
        }
    }

    public void ApplyConfig(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var selected = new HashSet<string>(StringComparer.Ordinal);
            if (root.TryGetProperty("metrics", out var metrics) && metrics.ValueKind == JsonValueKind.Array)
            {
                foreach (var metric in metrics.EnumerateArray())
                {
                    if (metric.ValueKind != JsonValueKind.String) continue;
                    var key = metric.GetString();
                    if (Metrics.Any(item => item.Key == key)) selected.Add(key!);
                }
            }
            if (selected.Count == 0) selected.UnionWith(["cpu", "gpu", "memory"]);

            var opacity = Number(root, "opacity") ?? 94;
            Opacity = Math.Clamp(opacity / 100d, 0.55d, 1d);
            if (!_visibleMetrics.SetEquals(selected))
            {
                _visibleMetrics.Clear();
                _visibleMetrics.UnionWith(selected);
            }
            RefreshMetrics();
        }
        catch (JsonException)
        {
            // Keep the last valid overlay setup if the page sends malformed settings.
        }
    }

    private void ReadSpecs(JsonElement root)
    {
        _memorySpeedMTs = null;
        if (root.TryGetProperty("memory", out var memory) &&
            memory.TryGetProperty("modules", out var modules) && modules.ValueKind == JsonValueKind.Array)
        {
            foreach (var module in modules.EnumerateArray())
            {
                var speed = Number(module, "configuredMTs") ?? Number(module, "speedMTs");
                if (speed is > 0)
                {
                    _memorySpeedMTs = speed;
                    break;
                }
            }
        }

        _primaryGpuLuid = null;
        _primaryGpuName = null;
        _vramTotal = null;
        if (!root.TryGetProperty("gpus", out var gpus) || gpus.ValueKind != JsonValueKind.Array) return;

        foreach (var gpu in gpus.EnumerateArray())
        {
            var vram = Number(gpu, "vram") ?? 0;
            if (_vramTotal is not null && vram <= _vramTotal) continue;
            _vramTotal = vram > 0 ? vram : null;
            _primaryGpuLuid = String(gpu, "luid");
            _primaryGpuName = String(gpu, "name");
        }
    }

    private void ReadLive(JsonElement root)
    {
        if (root.TryGetProperty("cpu", out var cpu))
        {
            _cpuLoad = Number(cpu, "total");
            // freqMHz is the base clock; scale by % performance to get the effective (turbo) clock
            var baseClock = Number(cpu, "freqMHz");
            var perfPct = Number(cpu, "perfPct");
            _cpuFrequencyMHz = baseClock is double b && perfPct is > 0 and double p ? b * p / 100 : baseClock;
        }

        if (root.TryGetProperty("memory", out var memory))
        {
            _memoryTotal = Number(memory, "total");
            var free = Number(memory, "free");
            _memoryUsed = _memoryTotal is double total && free is double available
                ? Math.Max(0, total - available)
                : null;
        }

        _gpuLoad = null;
        _vramUsed = null;
        if (root.TryGetProperty("gpus", out var gpus) && gpus.ValueKind == JsonValueKind.Array)
        {
            JsonElement fallback = default;
            var fallbackUsage = -1d;
            foreach (var gpu in gpus.EnumerateArray())
            {
                var usage = Number(gpu, "dedicated") ?? 0;
                var luid = String(gpu, "luid");
                if (_primaryGpuLuid is not null && string.Equals(luid, _primaryGpuLuid, StringComparison.OrdinalIgnoreCase))
                {
                    fallback = gpu;
                    break;
                }
                if (usage <= fallbackUsage) continue;
                fallbackUsage = usage;
                fallback = gpu;
            }
            if (fallback.ValueKind == JsonValueKind.Object)
            {
                _gpuLoad = Number(fallback, "util");
                _vramUsed = Number(fallback, "dedicated");
            }
        }

        _diskActivity = null;
        if (root.TryGetProperty("disks", out var disks) && disks.ValueKind == JsonValueKind.Array)
        {
            foreach (var disk in disks.EnumerateArray())
            {
                var active = Number(disk, "active");
                if (active is double value && (_diskActivity is null || value > _diskActivity))
                    _diskActivity = value;
            }
        }
    }

    private void ReadSensors(JsonElement root)
    {
        _cpuTemperature = FindTemperature(root, "Cpu", null, true);
        _gpuTemperature = FindTemperature(root, "Gpu", _primaryGpuName, false);
        _fanRpm = FindFan(root);
    }

    private static double? FindTemperature(JsonElement root, string hardwareType, string? preferredName, bool cpu)
    {
        if (!root.TryGetProperty("hardware", out var hardware) || hardware.ValueKind != JsonValueKind.Array) return null;

        var matches = new List<(int Priority, double Value)>();
        foreach (var item in hardware.EnumerateArray())
        {
            var type = String(item, "type") ?? "";
            var name = String(item, "name") ?? "";
            var matchesType = cpu
                ? type.Equals(hardwareType, StringComparison.OrdinalIgnoreCase)
                : type.StartsWith(hardwareType, StringComparison.OrdinalIgnoreCase);
            if (!matchesType || !item.TryGetProperty("sensors", out var sensors) || sensors.ValueKind != JsonValueKind.Array) continue;

            foreach (var sensor in sensors.EnumerateArray())
            {
                if (!string.Equals(String(sensor, "type"), "Temperature", StringComparison.OrdinalIgnoreCase)) continue;
                var value = Number(sensor, "value");
                if (value is not double temperature) continue;
                var sensorName = String(sensor, "name") ?? "";
                var priority = TemperaturePriority(sensorName, cpu);
                if (!cpu && preferredName is not null && name.Contains(preferredName, StringComparison.OrdinalIgnoreCase))
                    priority -= 10;
                matches.Add((priority, temperature));
            }
        }

        if (matches.Count == 0) return null;
        var bestPriority = matches.Min(match => match.Priority);
        var candidates = matches.Where(match => match.Priority == bestPriority).Select(match => match.Value);
        return bestPriority >= 90 ? candidates.Max() : candidates.First();
    }

    private static int TemperaturePriority(string name, bool cpu)
    {
        if (cpu)
        {
            if (name.Equals("CPU Package", StringComparison.OrdinalIgnoreCase)) return 0;
            if (name.Equals("Core (Tctl/Tdie)", StringComparison.OrdinalIgnoreCase)) return 1;
            if (name.Equals("Core (Tctl)", StringComparison.OrdinalIgnoreCase)) return 2;
            if (name.Equals("Core Max", StringComparison.OrdinalIgnoreCase)) return 3;
            if (name.Equals("Temperature", StringComparison.OrdinalIgnoreCase)) return 4;
            return name.Contains("core", StringComparison.OrdinalIgnoreCase) ? 5 : 90;
        }

        if (name.Equals("GPU Core", StringComparison.OrdinalIgnoreCase)) return 0;
        if (name.Equals("Core", StringComparison.OrdinalIgnoreCase)) return 1;
        if (name.Contains("hot spot", StringComparison.OrdinalIgnoreCase)) return 2;
        if (name.Equals("Temperature", StringComparison.OrdinalIgnoreCase)) return 3;
        return 90;
    }

    private static double? FindFan(JsonElement root)
    {
        if (!root.TryGetProperty("hardware", out var hardware) || hardware.ValueKind != JsonValueKind.Array) return null;

        var candidates = new List<(int Priority, double Value)>();
        foreach (var item in hardware.EnumerateArray())
        {
            if (!item.TryGetProperty("sensors", out var sensors) || sensors.ValueKind != JsonValueKind.Array) continue;
            foreach (var sensor in sensors.EnumerateArray())
            {
                if (!string.Equals(String(sensor, "type"), "Fan", StringComparison.OrdinalIgnoreCase)) continue;
                var value = Number(sensor, "value");
                if (value is not double rpm) continue;
                var name = String(sensor, "name") ?? "";
                var priority = name.Contains("CPU", StringComparison.OrdinalIgnoreCase) ? 0
                    : name.Contains("System", StringComparison.OrdinalIgnoreCase) || name.Contains("Chassis", StringComparison.OrdinalIgnoreCase) ? 1
                    : 2;
                candidates.Add((priority, rpm));
            }
        }

        if (candidates.Count == 0) return null;
        var bestPriority = candidates.Min(candidate => candidate.Priority);
        return candidates.First(candidate => candidate.Priority == bestPriority).Value;
    }

    private void RefreshMetrics()
    {
        var cpu = new List<string>();
        if (_cpuLoad is double load) cpu.Add(FormatNumber(load, "0") + "%");
        if (_cpuFrequencyMHz is > 0 and double frequency)
            cpu.Add(frequency >= 1000 ? FormatNumber(frequency / 1000, "0.00") + " GHz" : FormatNumber(frequency, "0") + " MHz");
        SetValue("cpu", cpu.Count == 0 ? EmptyValue : string.Join(" ", cpu), UsageColor(_cpuLoad, CpuColor));
        SetValue("cpuTemp", FormatTemperature(_cpuTemperature), TemperatureColorFor(_cpuTemperature));

        var gpu = _gpuLoad is double gpuLoad ? FormatNumber(gpuLoad, "0") + "%" : EmptyValue;
        SetValue("gpu", gpu, UsageColor(_gpuLoad, GpuColor));
        SetValue("gpuTemp", FormatTemperature(_gpuTemperature), TemperatureColorFor(_gpuTemperature));

        SetValue("memory", FormatPair(_memoryUsed, _memoryTotal), UsageColor(MemoryPercent(), MemoryColor));
        SetValue("memorySpeed", _memorySpeedMTs is double speed ? FormatNumber(speed, "0") + " MT/s" : EmptyValue, MemoryColor);
        SetValue("vram", FormatPair(_vramUsed, _vramTotal), GpuColor);
        SetValue("fan", _fanRpm is double rpm ? FormatNumber(rpm, "0") + " RPM" : EmptyValue, TemperatureColor);
        SetValue("disk", _diskActivity is double active ? FormatNumber(active, "0") + "%" : EmptyValue, UsageColor(_diskActivity, DiskColor));
        SetValue("fps", _fps is double fps ? FormatNumber(fps, "0") : EmptyValue, FrameColor);
        SetValue("frameTime", _frameTimeMs is double frameTime ? FormatNumber(frameTime, "0.00") + " ms" : EmptyValue, FrameColor);
        SetValue("low1", _low1Fps is double low1 ? FormatNumber(low1, "0") : EmptyValue, FrameColor);

        Relayout();
    }

    private double? MemoryPercent() =>
        _memoryUsed is double used && _memoryTotal is double total && total > 0 ? used / total * 100 : null;

    // "12.3/31.8 GB" keeps the value short enough for a single-line bar
    private static string FormatPair(double? used, double? total)
    {
        if (used is not double u) return EmptyValue;
        return total is double t && t > 0
            ? $"{FormatNumber(u / 1_073_741_824d, "0.0")}/{FormatNumber(t / 1_073_741_824d, "0.0")} GB"
            : $"{FormatNumber(u / 1_073_741_824d, "0.0")} GB";
    }

    private void SetValue(string key, string text, Color color) => _values[key] = (text, color);

    private static Color UsageColor(double? value, Color accent) => value >= 92 ? CriticalColor : value >= 80 ? WarningColor : accent;
    private static Color TemperatureColorFor(double? value) => value >= 85 ? CriticalColor : value >= 70 ? WarningColor : TemperatureColor;
    private static string FormatTemperature(double? value) => value is double temperature ? FormatNumber(temperature, "0.0") + "°C" : EmptyValue;
    private static string FormatNumber(double value, string format) => value.ToString(format, CultureInfo.InvariantCulture);

    private static double? Number(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
               element.TryGetProperty(propertyName, out var value) &&
               value.ValueKind == JsonValueKind.Number &&
               value.TryGetDouble(out var number) && double.IsFinite(number)
            ? number
            : null;
    }

    private static string? String(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
               element.TryGetProperty(propertyName, out var value) &&
               value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }
}
