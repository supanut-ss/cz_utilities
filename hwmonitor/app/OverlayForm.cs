using System.Globalization;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace HWMonitor;

/// <summary>Compact always-on-top view of the most useful live hardware metrics.</summary>
internal sealed class OverlayForm : Form
{
    private const string EmptyValue = "—";
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtCaption = 2;
    private const int CsDropShadow = 0x00020000;
    private const int CornerRadius = 14;
    private static readonly Color SurfaceColor = Color.FromArgb(15, 20, 27);
    private static readonly Color HeaderColor = Color.FromArgb(24, 32, 42);
    private static readonly Color BorderColor = Color.FromArgb(52, 65, 79);
    private static readonly Color TextColor = Color.FromArgb(230, 237, 243);
    private static readonly Color MutedColor = Color.FromArgb(139, 152, 167);
    private static readonly Color CpuColor = Color.FromArgb(56, 189, 248);
    private static readonly Color MemoryColor = Color.FromArgb(167, 139, 250);
    private static readonly Color GpuColor = Color.FromArgb(74, 222, 128);
    private static readonly Color DiskColor = Color.FromArgb(251, 191, 36);
    private static readonly Color TemperatureColor = Color.FromArgb(251, 146, 60);
    private static readonly Color FrameColor = Color.FromArgb(45, 212, 191);
    private static readonly Color WarningColor = Color.FromArgb(251, 191, 36);
    private static readonly Color CriticalColor = Color.FromArgb(248, 113, 113);

    private static readonly (string Key, string Caption, Color Accent)[] Metrics =
    [
        ("cpu", "CPU LOAD", CpuColor),
        ("cpuTemp", "CPU TEMP", TemperatureColor),
        ("gpu", "GPU LOAD", GpuColor),
        ("gpuTemp", "GPU TEMP", TemperatureColor),
        ("memory", "MEMORY", MemoryColor),
        ("memorySpeed", "RAM SPEED", MemoryColor),
        ("vram", "VRAM", GpuColor),
        ("fan", "FAN SPEED", TemperatureColor),
        ("disk", "DISK ACTIVE", DiskColor),
        ("fps", "FPS", FrameColor),
        ("frameTime", "FRAME TIME", FrameColor),
        ("low1", "1% LOW", FrameColor),
    ];

    private readonly Dictionary<string, Label> _values = new(StringComparer.Ordinal);
    private readonly TableLayoutPanel _layout;
    private readonly HashSet<string> _visibleMetrics = new(StringComparer.Ordinal);
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
        Text = "HW Monitor Overlay";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.Dpi;
        ShowInTaskbar = false;
        TopMost = true;
        Opacity = 0.94;
        BackColor = SurfaceColor;
        ForeColor = TextColor;
        ClientSize = new Size(390, 64 + 9 * 31);

        var left = Math.Max(workingArea.Left + 8, workingArea.Right - Width - 18);
        Location = new Point(left, workingArea.Top + 32);

        _layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            ColumnCount = 2,
            BackColor = BackColor,
        };
        Controls.Add(_layout);
        ApplyConfig("{\"metrics\":[\"cpu\",\"cpuTemp\",\"gpu\",\"gpuTemp\",\"memory\",\"vram\",\"fps\",\"frameTime\",\"low1\"],\"opacity\":94}");
        FormClosing += (_, e) =>
        {
            if (e.CloseReason != CloseReason.UserClosing) return;
            e.Cancel = true;
            Hide();
        };
        RefreshMetrics();
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

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        UpdateWindowRegion();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        UpdateWindowRegion();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = CreateRoundedPath(new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1), CornerRadius);
        using var pen = new Pen(BorderColor, 1);
        e.Graphics.DrawPath(pen, path);
    }

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
            var metricsChanged = !_visibleMetrics.SetEquals(selected);
            if (metricsChanged)
            {
                _visibleMetrics.Clear();
                _visibleMetrics.UnionWith(selected);
                RebuildLayout(selected);
            }
            else RefreshMetrics();
        }
        catch (JsonException)
        {
            // Keep the last valid overlay setup if the page sends malformed settings.
        }
    }

    private void RebuildLayout(HashSet<string> selected)
    {
        _layout.SuspendLayout();
        _layout.Controls.Clear();
        _layout.RowStyles.Clear();
        _layout.ColumnStyles.Clear();
        _values.Clear();
        _layout.ColumnCount = 2;
        _layout.RowCount = selected.Count + 1;
        _layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42));
        _layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58));
        _layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));

        var header = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = HeaderColor,
            Margin = new Padding(0, 0, 0, 7),
            Padding = new Padding(10, 0, 6, 0),
            AccessibleName = "Drag overlay to move",
        };
        var headerGrid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            BackColor = HeaderColor,
            Margin = Padding.Empty,
        };
        headerGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        headerGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 62));
        headerGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 28));

        var titleGroup = new Panel { Dock = DockStyle.Fill, BackColor = HeaderColor };
        var title = new Label
        {
            Text = "HW MONITOR",
            Location = new Point(0, 3),
            AutoSize = true,
            ForeColor = TextColor,
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
            AccessibleName = "Hardware monitoring overlay",
        };
        var dragHint = new Label
        {
            Text = "DRAG TO MOVE",
            Location = new Point(1, 20),
            AutoSize = true,
            ForeColor = MutedColor,
            Font = new Font("Segoe UI", 6.5f, FontStyle.Bold),
        };
        titleGroup.Controls.Add(title);
        titleGroup.Controls.Add(dragHint);

        var live = new Label
        {
            Text = "● LIVE",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.FromArgb(74, 222, 128),
            Font = new Font("Segoe UI", 7.5f, FontStyle.Bold),
            AccessibleName = "Live hardware readings",
        };
        var close = new Button
        {
            Text = "×",
            Dock = DockStyle.Fill,
            FlatStyle = FlatStyle.Flat,
            ForeColor = MutedColor,
            BackColor = HeaderColor,
            Font = new Font("Segoe UI", 14, FontStyle.Regular),
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            AccessibleName = "Hide hardware overlay",
            TabStop = false,
        };
        close.FlatAppearance.BorderSize = 0;
        close.FlatAppearance.MouseOverBackColor = Color.FromArgb(45, 55, 68);
        close.Click += (_, _) => Hide();

        headerGrid.Controls.Add(titleGroup, 0, 0);
        headerGrid.Controls.Add(live, 1, 0);
        headerGrid.Controls.Add(close, 2, 0);
        header.Controls.Add(headerGrid);
        EnableDragging(header);
        EnableDragging(headerGrid);
        EnableDragging(titleGroup);
        EnableDragging(title);
        EnableDragging(dragHint);
        EnableDragging(live);
        _layout.Controls.Add(header, 0, 0);
        _layout.SetColumnSpan(header, 2);

        var rows = Metrics.Where(metric => selected.Contains(metric.Key)).ToArray();
        for (var row = 0; row < rows.Length; row++)
        {
            _layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 31));
            AddMetric(_layout, row + 1, rows[row]);
        }
        ClientSize = new Size(390, 64 + rows.Length * 31);
        _layout.ResumeLayout(true);
        RefreshMetrics();
    }

    private static void EnableDragging(Control control) => control.MouseDown += DragOverlay;

    private static void DragOverlay(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left || sender is not Control control) return;
        var form = control.FindForm();
        if (form is null) return;
        ReleaseCapture();
        SendMessage(form.Handle, WmNcLButtonDown, new IntPtr(HtCaption), IntPtr.Zero);
    }

    private void UpdateWindowRegion()
    {
        if (!IsHandleCreated || ClientSize.Width < CornerRadius * 2 || ClientSize.Height < CornerRadius * 2) return;
        using var path = CreateRoundedPath(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height), CornerRadius);
        var nextRegion = new Region(path);
        var previousRegion = Region;
        Region = nextRegion;
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

    private void AddMetric(TableLayoutPanel layout, int row, (string Key, string Caption, Color Accent) metric)
    {
        layout.Controls.Add(new Label
        {
            Text = metric.Caption,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = MutedColor,
            Font = new Font("Segoe UI", 8, FontStyle.Bold),
            AccessibleName = metric.Caption,
        }, 0, row);

        var value = new Label
        {
            Text = EmptyValue,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleRight,
            ForeColor = metric.Accent,
            Font = new Font("Consolas", 10, FontStyle.Bold),
            AutoEllipsis = true,
            AccessibleName = $"{metric.Caption} value",
        };
        layout.Controls.Add(value, 1, row);
        _values.Add(metric.Key, value);
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
            _cpuFrequencyMHz = Number(cpu, "freqMHz");
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
        SetValue("cpu", cpu.Count == 0 ? EmptyValue : string.Join("  ·  ", cpu), UsageColor(_cpuLoad, CpuColor));
        SetValue("cpuTemp", FormatTemperature(_cpuTemperature), TemperatureColorFor(_cpuTemperature));

        var gpu = _gpuLoad is double gpuLoad ? FormatNumber(gpuLoad, "0") + "%" : EmptyValue;
        SetValue("gpu", gpu, UsageColor(_gpuLoad, GpuColor));
        SetValue("gpuTemp", FormatTemperature(_gpuTemperature), TemperatureColorFor(_gpuTemperature));

        SetValue("memory", FormatMemory(), MemoryColor);
        SetValue("memorySpeed", _memorySpeedMTs is double speed ? FormatNumber(speed, "0") + " MT/s" : EmptyValue, MemoryColor);
        SetValue("vram", FormatVram(), GpuColor);
        SetValue("fan", _fanRpm is double rpm ? FormatNumber(rpm, "0") + " RPM" : EmptyValue, TemperatureColor);
        SetValue("disk", _diskActivity is double active ? FormatNumber(active, "0") + "%" : EmptyValue, UsageColor(_diskActivity, DiskColor));
        SetValue("fps", _fps is double fps ? FormatNumber(fps, "0") : EmptyValue, FrameColor);
        SetValue("frameTime", _frameTimeMs is double frameTime ? FormatNumber(frameTime, "0.00") + " ms" : EmptyValue, FrameColor);
        SetValue("low1", _low1Fps is double low1 ? FormatNumber(low1, "0") : EmptyValue, FrameColor);
    }

    private string FormatMemory()
    {
        if (_memoryUsed is not double used || _memoryTotal is not double total || total <= 0) return EmptyValue;
        var percent = Math.Clamp(used / total * 100, 0, 100);
        return $"{Gigabytes(used)} / {Gigabytes(total)} ({FormatNumber(percent, "0")}%)";
    }

    private string FormatVram()
    {
        if (_vramUsed is not double used) return EmptyValue;
        return _vramTotal is double total && total > 0
            ? $"{Gigabytes(used)} / {Gigabytes(total)}"
            : $"{Gigabytes(used)} used";
    }

    private void SetValue(string key, string text, Color color)
    {
        if (!_values.TryGetValue(key, out var label)) return;
        label.Text = text;
        label.ForeColor = color;
    }

    private static Color UsageColor(double? value, Color accent) => value >= 92 ? CriticalColor : value >= 80 ? WarningColor : accent;
    private static Color TemperatureColorFor(double? value) => value >= 85 ? CriticalColor : value >= 70 ? WarningColor : TemperatureColor;
    private static string FormatTemperature(double? value) => value is double temperature ? FormatNumber(temperature, "0.0") + " °C" : EmptyValue;
    private static string Gigabytes(double bytes) => FormatNumber(bytes / 1_073_741_824d, "0.0") + " GB";
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
