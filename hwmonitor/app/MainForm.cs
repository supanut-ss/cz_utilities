using System.ComponentModel;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HWMonitor;

/// <summary>Hosts the dashboard in WebView2 and relays collector data to it via web messages.</summary>
internal sealed class MainForm : Form
{
    // Virtual origin served from embedded resources; never touches the network
    private const string Origin = "https://hwmonitor.local/";
    private static readonly Color DarkBg = Color.FromArgb(10, 14, 19);
    private static readonly HttpClient PresentMonHttpClient = CreatePresentMonHttpClient();
    private const string GameCaptureSessionName = "HWMonitor-GameCapture";
    private static readonly string[] GameInstallPathMarkers =
    [
        @"\steamapps\common\", @"\epic games\", @"\xboxgames\", @"\windowsapps\",
        @"\gog galaxy\games\", @"\gog games\", @"\ubisoft game launcher\games\",
        @"\origin games\", @"\games\",
    ];
    private static readonly HashSet<string> AutoCaptureExcludedProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "ApplicationFrameHost", "Battle.net", "ChatGPT", "EADesktop", "EpicGamesLauncher", "explorer",
        "GameBar", "GameBarFTServer", "GalaxyClient", "HWMonitor", "Paradox Launcher v2", "SearchHost",
        "ScreenClippingHost", "ScreenSketch", "ShellExperienceHost", "SnippingTool", "steam", "steamwebhelper",
        "UbisoftConnect", "XboxPcApp",
    };
    private const int OverlayHotkeyId = 0x484D;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private const uint ModNoRepeat = 0x4000;
    private const uint VkO = 0x4F;
    private const int WmHotkey = 0x0312;

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = DarkBg };
    private readonly Collectors _collectors;
    private readonly System.Windows.Forms.Timer _gameDetectionTimer = new() { Interval = 1000 };
    private readonly Dictionary<string, string> _latestData = new(StringComparer.Ordinal);
    private readonly object _gameCaptureGate = new();
    private OverlayForm? _overlay;
    private Process? _presentMonProcess;
    private string? _presentMonSessionName;
    private string? _capturedExecutablePath;
    private bool _gameCaptureAutomatic;
    private bool _autoGameCaptureEnabled;
    private string? _autoCandidatePath;
    private string? _lastAutoGameStatus;
    private DateTime _autoCandidateSinceUtc;
    private DateTime _lastAutoCaptureAttemptUtc;
    private string? _presentMonPath;
    private string _overlayConfigJson = "{\"metrics\":[\"cpu\",\"cpuTemp\",\"gpu\",\"gpuTemp\",\"memory\",\"vram\",\"fps\",\"frameTime\",\"low1\"],\"opacity\":94}";
    private bool _pageReady;

    // Tray: closing or minimizing hides the window; collectors, alerts, overlay and hotkey keep running
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _startupItem = new("Start with Windows");
    private FormWindowState _restoreState = FormWindowState.Maximized;
    private bool _exiting;
    private bool _trayHintShown;

    public MainForm(bool startInTray, WaitHandle showRequested)
    {
        Text = "HW Monitor";
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        BackColor = DarkBg;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1500, 960);
        MinimumSize = new Size(820, 600);
        // Started by the logon task: the form must still be shown once so WebView2 and the collectors start,
        // so it comes up minimized and hides itself right away
        WindowState = startInTray ? FormWindowState.Minimized : FormWindowState.Maximized;
        Controls.Add(_web);

        _tray = CreateTrayIcon();
        _collectors = new Collectors(Post);
        _gameDetectionTimer.Tick += (_, _) => TryAutoCaptureGame();
        Load += async (_, _) => await InitWebViewAsync();
        Shown += (_, _) =>
        {
            if (startInTray) Hide();
            _gameDetectionTimer.Start();
        };
        // Per-process sampling is only useful while the dashboard can be seen
        VisibleChanged += (_, _) => _collectors.WatchProcesses = Visible;
        Resize += (_, _) =>
        {
            if (WindowState == FormWindowState.Minimized) { if (Visible) Hide(); }
            else _restoreState = WindowState;
        };
        FormClosing += (_, e) =>
        {
            if (_exiting || e.CloseReason != CloseReason.UserClosing) return;
            e.Cancel = true;
            HideToTray();
        };
        // Another launch of the exe asks this instance to show itself (see Program)
        ThreadPool.RegisterWaitForSingleObject(showRequested, (_, _) =>
        {
            if (IsHandleCreated && !IsDisposed) BeginInvoke(ShowFromTray);
        }, null, Timeout.Infinite, executeOnlyOnce: false);
        FormClosed += (_, _) =>
        {
            _gameDetectionTimer.Stop();
            _gameDetectionTimer.Dispose();
            _tray.Visible = false;
            _tray.Dispose();
            StopGameCapture(notify: false);
            _overlay?.Dispose();
            _collectors.Dispose();
        };
    }

    private NotifyIcon CreateTrayIcon()
    {
        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Open HW Monitor", null, (_, _) => ShowFromTray())
        {
            Font = new Font(menu.Font, FontStyle.Bold),
        };
        menu.Items.Add(open);
        menu.Items.Add("Toggle overlay (Ctrl+Shift+O)", null, (_, _) => ToggleOverlay());
        menu.Items.Add(new ToolStripSeparator());
        _startupItem.Click += async (_, _) => await ToggleStartupAsync();
        menu.Items.Add(_startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApp());

        var tray = new NotifyIcon
        {
            Icon = Icon,
            Text = "HW Monitor",
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowFromTray(); };
        tray.BalloonTipClicked += (_, _) => ShowFromTray();

        // schtasks is slow-ish; read the startup state off the UI thread
        _ = Task.Run(() =>
        {
            try
            {
                StartupTask.RepairPathIfMoved(); // keep the task valid if the exe was moved
                return StartupTask.IsEnabled;
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                return false;
            }
        }).ContinueWith(t => _startupItem.Checked = t.Result, TaskScheduler.FromCurrentSynchronizationContext());
        return tray;
    }

    private void HideToTray()
    {
        Hide();
        if (_trayHintShown) return;
        _trayHintShown = true;
        _tray.ShowBalloonTip(3000, "HW Monitor is still running",
            "Monitoring continues in the tray. Right-click the icon to exit.", ToolTipIcon.Info);
    }

    /// <summary>Shows a threshold alert as a Windows notification; clicking it opens the dashboard.</summary>
    private void ShowAlertToast(string? title, string? body)
    {
        if (string.IsNullOrWhiteSpace(title)) return;
        // Windows truncates balloon titles at 63 and text at 255 characters
        _tray.ShowBalloonTip(10_000, Truncate(title, 63), Truncate(body ?? "", 255), ToolTipIcon.Warning);
    }

    private static string Truncate(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";

    private void ShowFromTray()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = _restoreState;
        Activate();
    }

    private void ExitApp()
    {
        _exiting = true;
        Close();
    }

    private async Task ToggleStartupAsync()
    {
        var enable = !_startupItem.Checked;
        _startupItem.Enabled = false;
        try
        {
            await Task.Run(() => { if (enable) StartupTask.Enable(); else StartupTask.Disable(); });
            _startupItem.Checked = enable;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or IOException)
        {
            MessageBox.Show(this, $"Could not change the startup setting.\n{ex.Message}", "HW Monitor",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _startupItem.Enabled = true;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        SetDarkTitleBar(true);
        RegisterHotKey(Handle, OverlayHotkeyId, ModControl | ModShift | ModNoRepeat, VkO);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        UnregisterHotKey(Handle, OverlayHotkeyId);
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmHotkey && message.WParam.ToInt32() == OverlayHotkeyId)
        {
            ToggleOverlay();
            return;
        }
        base.WndProc(ref message);
    }

    private async Task InitWebViewAsync()
    {
        // Always elevated (see app.manifest); "-admin" keeps it apart from profiles made by older unelevated builds
        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HWMonitor", "WebView2-admin");
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this, "HW Monitor needs the Microsoft Edge WebView2 Runtime.\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703",
                "HW Monitor", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsWebMessageEnabled = true;
#if !DEBUG
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += ServeEmbeddedFile;
        core.WebMessageReceived += OnWebMessage;
        core.NewWindowRequested += (_, e) => e.Handled = true; // keep everything in this window

        _collectors.Start();
        core.Navigate(Origin + "index.html");
    }

    private void ServeEmbeddedFile(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var path = new Uri(e.Request.Uri).AbsolutePath.TrimStart('/');
        if (path.Length == 0) path = "index.html";

        var env = _web.CoreWebView2.Environment;
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("public/" + path);
        e.Response = stream is null
            ? env.CreateWebResourceResponse(null, 404, "Not Found", "")
            : env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {MimeType(path)}\r\nCache-Control: no-cache");
    }

    private static string MimeType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using var doc = JsonDocument.Parse(e.WebMessageAsJson);
        var msg = doc.RootElement;
        switch (msg.GetProperty("type").GetString())
        {
            case "ready":
                _pageReady = true;
                foreach (var (evt, data) in _collectors.Latest()) Post(evt, data);
                break;

            case "specs":
                var refresh = msg.TryGetProperty("refresh", out var r) && r.GetBoolean();
                try { Post("specs", await _collectors.GetSpecsAsync(refresh)); }
                catch (Exception ex) { Post("specs-error", JsonSerializer.Serialize(new { error = ex.Message })); }
                break;

            case "theme":
                SetDarkTitleBar(msg.GetProperty("dark").GetBoolean());
                break;

            case "toast":
                ShowAlertToast(msg.GetProperty("title").GetString(), msg.GetProperty("body").GetString());
                break;

            case "overlay-toggle":
                ToggleOverlay();
                break;

        case "overlay-config":
            if (msg.TryGetProperty("config", out var overlayConfig) && overlayConfig.ValueKind == JsonValueKind.Object)
            {
                _overlayConfigJson = overlayConfig.GetRawText();
                _overlay?.ApplyConfig(_overlayConfigJson);
            }
            break;

        case "game-processes":
            PostGameProcesses();
            break;

        case "game-auto-detect":
            _autoGameCaptureEnabled = msg.TryGetProperty("enabled", out var autoDetectValue) &&
                autoDetectValue.ValueKind == JsonValueKind.True;
            _autoCandidatePath = null;
            PostAutoGameStatus(_autoGameCaptureEnabled
                ? "Auto-detect is on. Focus a game to start capture."
                : "Auto-detect is off.");
            if (!_autoGameCaptureEnabled && _gameCaptureAutomatic) StopGameCapture();
            break;

        case "presentmon-state":
            var requestedPath = msg.TryGetProperty("path", out var pathValue) && pathValue.ValueKind == JsonValueKind.String
                ? pathValue.GetString()
                : null;
            await ResolvePresentMonAsync(requestedPath);
            break;

        case "game-locate-presentmon":
            BrowseForPresentMon();
            break;

        case "game-start":
            if (msg.TryGetProperty("processId", out var processId) && processId.TryGetInt32(out var pid))
                StartGameCapture(pid);
            break;

        case "game-stop":
            StopGameCapture();
            break;

        case "open-external":
            if (msg.TryGetProperty("url", out var externalUrl) && externalUrl.ValueKind == JsonValueKind.String)
                OpenPresentMonPage(externalUrl.GetString());
            break;
        }
    }

    private void ToggleOverlay()
    {
        if (_overlay is null || _overlay.IsDisposed)
        {
            var overlay = new OverlayForm(Screen.FromControl(this).WorkingArea);
            overlay.ApplyConfig(_overlayConfigJson);
            overlay.VisibleChanged += (_, _) =>
                Post("overlay-state", JsonSerializer.Serialize(new { visible = overlay.Visible }));
            foreach (var (evt, data) in _latestData) overlay.ApplySnapshot(evt, data);
            _overlay = overlay;
        }

        if (_overlay.Visible)
        {
            _overlay.Hide();
            return;
        }

        // Show without activating so the hotkey never pulls focus away from a game
        _overlay.Show();
        _overlay.BringToFront();
    }

    private sealed record GameProcess(
        [property: System.Text.Json.Serialization.JsonPropertyName("id")] int Id,
        [property: System.Text.Json.Serialization.JsonPropertyName("name")] string Name,
        [property: System.Text.Json.Serialization.JsonPropertyName("title")] string Title);

    private sealed record AutoGameCandidate(int ProcessId, string ProcessName, string Title, string ExecutablePath);

    private void PostGameProcesses()
    {
        var processes = new List<GameProcess>();
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (process.Id == Environment.ProcessId) continue;
                var title = process.MainWindowTitle;
                if (process.MainWindowHandle == IntPtr.Zero && string.IsNullOrWhiteSpace(title)) continue;
                processes.Add(new GameProcess(process.Id, process.ProcessName, title));
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or ArgumentException)
            {
                // The process may exit while the app list is being collected.
            }
            finally
            {
                process.Dispose();
            }
        }

        var result = processes
            .OrderByDescending(process => !string.IsNullOrWhiteSpace(process.Title))
            .ThenBy(process => process.Title.Length == 0 ? process.Name : process.Title, StringComparer.CurrentCultureIgnoreCase)
            .Take(120);
        Post("game-processes", JsonSerializer.Serialize(new { processes = result }));
    }

    private void TryAutoCaptureGame()
    {
        if (!_autoGameCaptureEnabled || !_pageReady || !IsPresentMonExecutable(_presentMonPath)) return;

        if (IsManualGameCaptureRunning())
        {
            _autoCandidatePath = null;
            PostAutoGameStatus("Manual capture is active. Auto-detect will resume when it stops.");
            return;
        }

        var candidate = FindAutoGameCandidate();
        if (candidate is null)
        {
            _autoCandidatePath = null;
            PostAutoGameStatus("Auto-detect is on. Focus a game from Steam, Epic, Xbox, GOG or a Games folder.");
            return;
        }

        if (string.Equals(_capturedExecutablePath, candidate.ExecutablePath, StringComparison.OrdinalIgnoreCase) &&
            IsGameCaptureRunning())
        {
            _autoCandidatePath = candidate.ExecutablePath;
            return;
        }

        if (!string.Equals(_autoCandidatePath, candidate.ExecutablePath, StringComparison.OrdinalIgnoreCase))
        {
            _autoCandidatePath = candidate.ExecutablePath;
            _autoCandidateSinceUtc = DateTime.UtcNow;
            PostAutoGameStatus($"Detected {candidate.ProcessName}; confirming the game window…");
            return;
        }

        if (DateTime.UtcNow - _autoCandidateSinceUtc < TimeSpan.FromMilliseconds(1500) ||
            DateTime.UtcNow - _lastAutoCaptureAttemptUtc < TimeSpan.FromSeconds(3)) return;

        _lastAutoCaptureAttemptUtc = DateTime.UtcNow;
        PostGameProcesses();
        Post("game-auto-detected", JsonSerializer.Serialize(new
        {
            processId = candidate.ProcessId,
            processName = candidate.ProcessName,
            title = candidate.Title,
        }));
        PostAutoGameStatus($"Auto-capturing {candidate.ProcessName}…");
        StartGameCapture(candidate.ProcessId, automatic: true);
    }

    private static AutoGameCandidate? FindAutoGameCandidate()
    {
        var candidates = new List<AutoGameCandidate>();
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (process.Id == Environment.ProcessId || AutoCaptureExcludedProcesses.Contains(process.ProcessName)) continue;
                var window = process.MainWindowHandle;
                if (window == IntPtr.Zero || !IsWindowVisible(window) || IsIconic(window)) continue;

                var executablePath = process.MainModule?.FileName;
                if (string.IsNullOrWhiteSpace(executablePath) || !IsSupportedGamePath(executablePath)) continue;
                candidates.Add(new AutoGameCandidate(process.Id, process.ProcessName, process.MainWindowTitle, executablePath));
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or ArgumentException or NotSupportedException)
            {
                // The process may exit or deny module access while the game list is scanned.
            }
            finally
            {
                process.Dispose();
            }
        }

        var foregroundProcessId = GetForegroundProcessId();
        var foregroundCandidate = candidates.FirstOrDefault(candidate => candidate.ProcessId == foregroundProcessId);
        if (foregroundCandidate is not null) return foregroundCandidate;

        var executablePaths = candidates.Select(candidate => candidate.ExecutablePath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(2)
            .Count();
        return executablePaths == 1 ? candidates[0] : null;
    }

    private static bool IsSupportedGamePath(string executablePath)
    {
        var normalizedPath = executablePath.Replace('/', '\\');
        return GameInstallPathMarkers.Any(marker => normalizedPath.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    private bool IsGameCaptureRunning()
    {
        lock (_gameCaptureGate)
        {
            if (_presentMonProcess is null) return false;
            try { return !_presentMonProcess.HasExited; }
            catch (InvalidOperationException) { return false; }
        }
    }

    private bool IsManualGameCaptureRunning()
    {
        lock (_gameCaptureGate)
        {
            if (_gameCaptureAutomatic || _presentMonProcess is null) return false;
            try { return !_presentMonProcess.HasExited; }
            catch (InvalidOperationException) { return false; }
        }
    }

    private void PostAutoGameStatus(string message)
    {
        if (string.Equals(_lastAutoGameStatus, message, StringComparison.Ordinal)) return;
        _lastAutoGameStatus = message;
        Post("game-auto-state", JsonSerializer.Serialize(new { enabled = _autoGameCaptureEnabled, message }));
    }

    private async Task ResolvePresentMonAsync(string? preferredPath)
    {
        _presentMonPath = IsPresentMonExecutable(preferredPath) ? preferredPath : FindPresentMonExecutable();
        if (_presentMonPath is not null)
        {
            Post("presentmon-state", JsonSerializer.Serialize(new { path = _presentMonPath }));
            return;
        }

        Post("presentmon-state", JsonSerializer.Serialize(new
        {
            path = (string?)null,
            busy = true,
            message = "Downloading PresentMon automatically…",
        }));
        try
        {
            _presentMonPath = await DownloadLatestPresentMonAsync();
            Post("presentmon-state", JsonSerializer.Serialize(new { path = _presentMonPath }));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or
            UnauthorizedAccessException or JsonException or CryptographicException or InvalidOperationException or
            InvalidDataException or FormatException)
        {
            _presentMonPath = null;
            Post("presentmon-state", JsonSerializer.Serialize(new
            {
                path = (string?)null,
                message = "Automatic setup failed. Check your connection or locate PresentMon.exe manually.",
            }));
        }
    }

    private static HttpClient CreatePresentMonHttpClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(45) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("HWMonitor/1.0");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return client;
    }

    private static async Task<string> DownloadLatestPresentMonAsync()
    {
        using var releaseResponse = await PresentMonHttpClient.GetAsync(
            "https://api.github.com/repos/GameTechDev/PresentMon/releases/latest",
            HttpCompletionOption.ResponseHeadersRead);
        releaseResponse.EnsureSuccessStatusCode();
        await using var releaseStream = await releaseResponse.Content.ReadAsStreamAsync();
        using var releaseDocument = await JsonDocument.ParseAsync(releaseStream);
        var root = releaseDocument.RootElement;
        if (!root.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("PresentMon release metadata did not contain assets.");

        JsonElement executableAsset = default;
        foreach (var asset in assets.EnumerateArray())
        {
            if (!asset.TryGetProperty("name", out var nameValue) || nameValue.ValueKind != JsonValueKind.String) continue;
            var name = nameValue.GetString();
            if (name is not null && name.StartsWith("PresentMon-", StringComparison.OrdinalIgnoreCase) &&
                name.EndsWith("-x64.exe", StringComparison.OrdinalIgnoreCase))
            {
                executableAsset = asset;
                break;
            }
        }
        if (executableAsset.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("The latest PresentMon release did not contain an x64 console executable.");

        var assetName = executableAsset.GetProperty("name").GetString();
        var downloadUrl = executableAsset.GetProperty("browser_download_url").GetString();
        var digest = executableAsset.TryGetProperty("digest", out var digestValue) ? digestValue.GetString() : null;
        var expectedSize = executableAsset.TryGetProperty("size", out var sizeValue) && sizeValue.TryGetInt64(out var parsedSize)
            ? parsedSize
            : 0;
        if (string.IsNullOrWhiteSpace(assetName) || Path.GetFileName(assetName) != assetName ||
            !HasPresentMonExecutableName(assetName) || !assetName.EndsWith("-x64.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The PresentMon release contained an invalid executable name.");
        if (!Uri.TryCreate(downloadUrl, UriKind.Absolute, out var binaryUri) || binaryUri.Scheme != Uri.UriSchemeHttps ||
            !binaryUri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) ||
            !binaryUri.AbsolutePath.StartsWith("/GameTechDev/PresentMon/releases/download/", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The PresentMon release contained an untrusted download URL.");
        if (expectedSize <= 0 || expectedSize > 64 * 1024 * 1024)
            throw new InvalidDataException("The PresentMon executable size was outside the expected range.");
        if (digest is null || !digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) || digest.Length != 71)
            throw new InvalidDataException("The PresentMon release did not provide a SHA-256 digest.");

        var expectedHash = Convert.FromHexString(digest[7..]);
        var localToolsDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HWMonitor", "tools");
        Directory.CreateDirectory(localToolsDirectory);
        var executablePath = Path.Combine(localToolsDirectory, assetName);
        if (File.Exists(executablePath))
        {
            using var existingStream = File.OpenRead(executablePath);
            var existingHash = await SHA256.HashDataAsync(existingStream);
            if (CryptographicOperations.FixedTimeEquals(existingHash, expectedHash)) return executablePath;
        }

        using var executableResponse = await PresentMonHttpClient.GetAsync(binaryUri, HttpCompletionOption.ResponseHeadersRead);
        executableResponse.EnsureSuccessStatusCode();
        var executableBytes = await executableResponse.Content.ReadAsByteArrayAsync();
        if (executableBytes.LongLength != expectedSize ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(executableBytes), expectedHash))
            throw new CryptographicException("The downloaded PresentMon executable failed its size or SHA-256 check.");

        var temporaryPath = executablePath + ".download";
        try
        {
            await File.WriteAllBytesAsync(temporaryPath, executableBytes);
            File.Move(temporaryPath, executablePath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
        return executablePath;
    }

    private static string? FindPresentMonExecutable()
    {
        var directories = new List<string>
        {
            AppContext.BaseDirectory,
            Path.Combine(AppContext.BaseDirectory, "tools"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HWMonitor", "tools"),
        };
        directories.AddRange((Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(directory => directory.Trim('"')));

        foreach (var directory in directories.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var match = Directory.EnumerateFiles(directory, "PresentMon*.exe", SearchOption.TopDirectoryOnly)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .FirstOrDefault(IsPresentMonExecutable);
                if (match is not null) return match;
            }
            catch (Exception ex) when (ex is DirectoryNotFoundException or IOException or UnauthorizedAccessException or ArgumentException)
            {
                // Ignore unavailable PATH entries and continue searching.
            }
        }
        return null;
    }

    private static bool IsPresentMonExecutable(string? path) =>
        !string.IsNullOrWhiteSpace(path) && File.Exists(path) && HasPresentMonExecutableName(path);

    private static bool HasPresentMonExecutableName(string path)
    {
        if (!Path.GetExtension(path).Equals(".exe", StringComparison.OrdinalIgnoreCase)) return false;
        var name = Path.GetFileNameWithoutExtension(path);
        return name.Equals("PresentMon", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("PresentMon-", StringComparison.OrdinalIgnoreCase) &&
            name.EndsWith("-x64", StringComparison.OrdinalIgnoreCase);
    }


    private void BrowseForPresentMon()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Select PresentMon console application",
            Filter = "PresentMon executable (PresentMon*.exe)|PresentMon*.exe|Executable files (*.exe)|*.exe",
            CheckFileExists = true,
            Multiselect = false,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        if (!IsPresentMonExecutable(dialog.FileName))
        {
            MessageBox.Show(this, "Choose the PresentMon console executable (PresentMon*.exe).", "PresentMon", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        _presentMonPath = dialog.FileName;
        Post("presentmon-state", JsonSerializer.Serialize(new { path = _presentMonPath }));
    }

    private void StartGameCapture(int processId, bool automatic = false)
    {
        if (!IsPresentMonExecutable(_presentMonPath))
        {
            Post("game-state", JsonSerializer.Serialize(new { state = "error", message = "Choose a valid PresentMon.exe before starting capture." }));
            return;
        }

        string processName;
        string executablePath;
        try
        {
            using var target = Process.GetProcessById(processId);
            processName = target.ProcessName;
            executablePath = target.MainModule?.FileName ?? string.Empty;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Win32Exception)
        {
            Post("game-state", JsonSerializer.Serialize(new { state = "error", message = "That app has closed. Refresh the running app list." }));
            return;
        }

        var executableName = Path.GetFileName(executablePath);
        if (string.IsNullOrWhiteSpace(executableName)) executableName = processName + ".exe";
        StopGameCapture(notify: false);
        var startInfo = new ProcessStartInfo(_presentMonPath!)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in new[]
        {
            "--process_name", executableName,
            "--output_stdout", "--no_console_stats", "--v1_metrics",
            "--session_name", GameCaptureSessionName,
            "--stop_existing_session", "--terminate_on_proc_exit",
        })
            startInfo.ArgumentList.Add(argument);

        try
        {
            var process = Process.Start(startInfo);
            if (process is null)
            {
                Post("game-state", JsonSerializer.Serialize(new { state = "error", message = "Windows could not start PresentMon." }));
                return;
            }

            lock (_gameCaptureGate)
            {
                _presentMonProcess = process;
                _presentMonSessionName = GameCaptureSessionName;
                _capturedExecutablePath = string.IsNullOrWhiteSpace(executablePath) ? null : executablePath;
                _gameCaptureAutomatic = automatic;
            }
            Post("game-state", JsonSerializer.Serialize(new { state = "running", processId, processName, executableName, automatic }));
            _ = CapturePresentMonAsync(process, processName, automatic);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
        {
            Post("game-state", JsonSerializer.Serialize(new { state = "error", message = $"Could not start PresentMon: {ex.Message}" }));
        }
    }

    private void StopGameCapture(bool notify = true)
    {
        Process? process;
        string? sessionName;
        lock (_gameCaptureGate)
        {
            process = _presentMonProcess;
            _presentMonProcess = null;
            sessionName = _presentMonSessionName;
            _presentMonSessionName = null;
            _capturedExecutablePath = null;
            _gameCaptureAutomatic = false;
        }

        StopPresentMonSession(sessionName);
        if (process is not null)
        {
            try
            {
                if (!process.HasExited) process.WaitForExit(1000);
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException or ObjectDisposedException)
            {
                // It may have exited while the capture is stopping.
            }
        }
        if (notify) Post("game-state", JsonSerializer.Serialize(new { state = "stopped", message = "Capture stopped." }));
    }

    private void StopPresentMonSession(string? sessionName)
    {
        if (string.IsNullOrWhiteSpace(sessionName) || !IsPresentMonExecutable(_presentMonPath)) return;
        try
        {
            var startInfo = new ProcessStartInfo(_presentMonPath!)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("--session_name");
            startInfo.ArgumentList.Add(sessionName);
            startInfo.ArgumentList.Add("--terminate_existing_session");
            using var stopper = Process.Start(startInfo);
            if (stopper is not null && !stopper.WaitForExit(2000)) stopper.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException or NotSupportedException)
        {
            // Starting the next capture also uses --stop_existing_session for this name.
        }
    }

    private async Task CapturePresentMonAsync(Process process, string processName, bool automatic)
    {
        var errors = new ConcurrentQueue<string>();
        var firstFrame = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var errorReader = ReadPresentMonErrorsAsync(process, errors);
        var outputReader = ReadPresentMonMetricsAsync(process, processName, firstFrame);
        try
        {
            var exitTask = process.WaitForExitAsync();
            var firstFrameOrExit = await Task.WhenAny(firstFrame.Task, exitTask, Task.Delay(TimeSpan.FromSeconds(8)));
            if (firstFrameOrExit != firstFrame.Task && firstFrameOrExit != exitTask && !process.HasExited)
                Post("game-state", JsonSerializer.Serialize(new
                {
                    state = "waiting",
                    message = $"PresentMon is watching {processName}, waiting for rendered frames.",
                    automatic,
                }));

            await process.WaitForExitAsync();
            var hasHeader = await outputReader;
            await errorReader;
            var exitCode = process.ExitCode;
            var detail = string.Join(" ", errors.TakeLast(3));
            var friendlyError = detail.Contains("access denied", StringComparison.OrdinalIgnoreCase)
                ? "PresentMon access was denied. Add your account to Performance Log Users and try again."
                : !string.IsNullOrWhiteSpace(detail) ? $"PresentMon: {detail}"
                : !hasHeader ? "No frame data was received. Confirm the selected app is running and rendering frames."
                : exitCode != 0 ? $"PresentMon exited with code {exitCode}."
                : null;

            var isCurrent = false;
            lock (_gameCaptureGate)
            {
                isCurrent = ReferenceEquals(_presentMonProcess, process);
                if (isCurrent) _presentMonProcess = null;
            }
            if (isCurrent)
                Post("game-state", JsonSerializer.Serialize(friendlyError is null
                    ? new { state = "stopped", message = $"{processName} capture ended." }
                    : new { state = "error", message = friendlyError }));
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or System.ComponentModel.Win32Exception or ObjectDisposedException)
        {
            var isCurrent = false;
            lock (_gameCaptureGate)
            {
                isCurrent = ReferenceEquals(_presentMonProcess, process);
                if (isCurrent) _presentMonProcess = null;
            }
            if (isCurrent) Post("game-state", JsonSerializer.Serialize(new { state = "error", message = $"PresentMon capture stopped: {ex.Message}" }));
        }
        finally
        {
            process.Dispose();
        }
    }

    private static async Task ReadPresentMonErrorsAsync(Process process, ConcurrentQueue<string> errors)
    {
        while (await process.StandardError.ReadLineAsync() is { } line)
        {
            if (line.Contains("error", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("access denied", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("failed to start", StringComparison.OrdinalIgnoreCase))
            {
                errors.Enqueue(line.Trim());
                while (errors.Count > 8) errors.TryDequeue(out _);
            }
        }
    }

    private async Task<bool> ReadPresentMonMetricsAsync(Process process, string processName, TaskCompletionSource<bool> firstFrame)
    {
        string[]? headers = null;
        var frameIndex = -1;
        var rollingFrames = new Queue<(DateTime At, double FrameMs)>();
        var currentFrames = new List<double>();
        var bucketStart = DateTime.UtcNow;

        while (await process.StandardOutput.ReadLineAsync() is { } rawLine)
        {
            var line = rawLine.TrimStart('\uFEFF').Trim();
            if (line.Length == 0) continue;
            var fields = ParseCsvRow(line);
            if (headers is null)
            {
                var index = Array.FindIndex(fields, field =>
                    field.Equals("MsBetweenPresents", StringComparison.OrdinalIgnoreCase) ||
                    field.Equals("MsBetweenDisplayChange", StringComparison.OrdinalIgnoreCase) ||
                    field.Equals("DisplayedTime", StringComparison.OrdinalIgnoreCase));
                if (index < 0) continue;
                headers = fields;
                frameIndex = index;
                continue;
            }
            if (fields.Length <= frameIndex || !double.TryParse(fields[frameIndex], NumberStyles.Float, CultureInfo.InvariantCulture, out var frameMs) ||
                !double.IsFinite(frameMs) || frameMs <= 0 || frameMs > 1000) continue;

            firstFrame.TrySetResult(true);
            var now = DateTime.UtcNow;
            rollingFrames.Enqueue((now, frameMs));
            currentFrames.Add(frameMs);
            while (rollingFrames.Count > 0 && now - rollingFrames.Peek().At > TimeSpan.FromSeconds(60)) rollingFrames.Dequeue();
            if ((now - bucketStart).TotalSeconds < 1) continue;

            if (currentFrames.Count > 0)
            {
                var averageFrameMs = currentFrames.Average();
                var sorted = rollingFrames.Select(frame => frame.FrameMs).OrderByDescending(value => value).ToArray();
                var slowCount = Math.Max(1, (int)Math.Ceiling(sorted.Length * 0.01));
                double? low1 = sorted.Length >= 100 ? 1000d / sorted.Take(slowCount).Average() : null;
                var fps = currentFrames.Count / Math.Max(0.25, (now - bucketStart).TotalSeconds);
                Post("game-metrics", JsonSerializer.Serialize(new
                {
                    processName,
                    fps = Math.Round(fps, 1),
                    frameTimeMs = Math.Round(averageFrameMs, 2),
                    low1Fps = low1 is double value ? Math.Round(value, 1) : (double?)null,
                    capturedAt = now,
                }));
            }
            currentFrames.Clear();
            bucketStart = now;
        }
        return headers is not null;
    }

    private static string[] ParseCsvRow(string line)
    {
        var fields = new List<string>();
        var field = new System.Text.StringBuilder();
        var quoted = false;
        for (var index = 0; index < line.Length; index++)
        {
            var character = line[index];
            if (character == '"')
            {
                if (quoted && index + 1 < line.Length && line[index + 1] == '"')
                {
                    field.Append('"');
                    index++;
                }
                else quoted = !quoted;
            }
            else if (character == ',' && !quoted)
            {
                fields.Add(field.ToString());
                field.Clear();
            }
            else field.Append(character);
        }
        fields.Add(field.ToString());
        return [.. fields];
    }

    private static void OpenPresentMonPage(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) ||
            !uri.AbsolutePath.StartsWith("/GameTechDev/PresentMon/releases", StringComparison.OrdinalIgnoreCase)) return;
        try { Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true }); }
        catch (Win32Exception) { /* Browser unavailable */ }
    }

    /// <summary>Sends {event, data} to the page. Safe to call from any thread.</summary>
    private void Post(string evt, string json)
    {
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(() =>
        {
            _latestData[evt] = json;
            _overlay?.ApplySnapshot(evt, json);
            if (_pageReady && _web.CoreWebView2 is { } core)
                core.PostWebMessageAsJson($"{{\"event\":{JsonSerializer.Serialize(evt)},\"data\":{json}}}");
        });
    }

    private static int GetForegroundProcessId()
    {
        var foregroundWindow = GetForegroundWindow();
        if (foregroundWindow == IntPtr.Zero) return 0;
        _ = GetWindowThreadProcessId(foregroundWindow, out var processId);
        return processId <= int.MaxValue ? (int)processId : 0;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private void SetDarkTitleBar(bool dark)
    {
        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        var value = dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int));
    }
}
