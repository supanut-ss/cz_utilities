using AIQuotaMonitor.Models;
using AIQuotaMonitor.Providers;
using AIQuotaMonitor.Settings;
using AIQuotaMonitor.Security;
using AIQuotaMonitor.Notifications;

namespace AIQuotaMonitor;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MonitorContext([new ManualTrackerProvider(), new OpenAiUsageProvider(), new GitHubCopilotProvider()]));
    }
}

internal sealed class MonitorContext : ApplicationContext
{
    private readonly MonitorForm _window;
    private readonly NotifyIcon _tray;
    private readonly IReadOnlyList<IQuotaProvider> _providers;
    private readonly OverlayForm _overlay;
    private readonly System.Windows.Forms.Timer _refreshTimer;
    private readonly System.Windows.Forms.Timer _minuteTimer;
    private readonly ResetNotifier _notifier = new();
    private AppSettings _settings;
    private IReadOnlyList<QuotaSnapshot> _snapshots = [];
    private bool _refreshing;
    private bool _quitting;

    public MonitorContext(IReadOnlyList<IQuotaProvider> providers)
    {
        _providers = providers;
        _settings = AppSettings.Load();
        _window = new MonitorForm();
        _overlay = new OverlayForm { TopMost = _settings.OverlayTopMost };
        var workArea = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1200, 800);
        var preferred = new Point(_settings.OverlayX ?? workArea.Right - 340,
            _settings.OverlayY ?? workArea.Top + 20);
        _overlay.Location = Screen.AllScreens.Any(screen => screen.WorkingArea.Contains(preferred))
            ? preferred : new Point(workArea.Right - 340, workArea.Top + 20);
        _overlay.HideRequested += (_, _) =>
        {
            _overlay.Hide();
            _window.SetOverlayVisible(false);
        };
        _overlay.OpenMainRequested += (_, _) => ShowWindow();
        _overlay.ResetPositionRequested += (_, _) => ResetOverlayPosition();
        _overlay.PositionChanged += (_, _) =>
        {
            try
            {
                _settings = _settings with { OverlayX = _overlay.Left, OverlayY = _overlay.Top };
                _settings.Save();
            }
            catch (IOException ex) { _window.ShowError("Could not save overlay position: " + ex.Message); }
        };
        _window.FormClosing += (_, args) =>
        {
            if (_quitting) return;
            args.Cancel = true;
            _window.Hide();
        };
        _window.RefreshRequested += async (_, _) => await RefreshAsync();
        _window.ConnectRequested += (_, _) => ConnectOpenAi();
        _window.DisconnectRequested += (_, _) => DisconnectOpenAi();
        _window.AddManualRequested += (_, _) => AddManualTracker();
        _window.RemoveManualRequested += id => RemoveManualTracker(id);
        _window.ConnectGitHubRequested += (_, _) => ConnectGitHub();
        _window.DisconnectGitHubRequested += (_, _) => DisconnectGitHub();
        _window.SettingsRequested += (_, _) => OpenSettings();
        _window.OverlayRequested += (_, _) => ToggleOverlay();

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open monitor", null, (_, _) => ShowWindow());
        menu.Items.Add("Show / hide overlay", null, (_, _) => ToggleOverlay());
        menu.Items.Add("Refresh", null, async (_, _) => await RefreshAsync());
        menu.Items.Add("Settings", null, (_, _) => OpenSettings());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => Quit());

        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "AI Quota Monitor",
            ContextMenuStrip = menu,
            Visible = true
        };
        _tray.DoubleClick += (_, _) => ShowWindow();
        _refreshTimer = new System.Windows.Forms.Timer
        {
            Interval = Math.Clamp(_settings.RefreshMinutes, 1, 60) * 60_000
        };
        _refreshTimer.Tick += async (_, _) => await RefreshAsync();
        _refreshTimer.Start();
        _minuteTimer = new System.Windows.Forms.Timer { Interval = 60_000 };
        _minuteTimer.Tick += (_, _) =>
        {
            _overlay.ShowSnapshots(_snapshots);
            CheckNotifications();
        };
        _minuteTimer.Start();
        if (!_settings.StartMinimized) _window.Show();
        if (_settings.ShowOverlayOnLaunch)
        {
            _overlay.Show();
            _window.SetOverlayVisible(true);
        }
        UpdateConnectionStates();
        _ = RefreshAsync();
    }

    private void ShowWindow()
    {
        _window.Show();
        _window.WindowState = FormWindowState.Normal;
        _window.Activate();
    }

    private async Task RefreshAsync()
    {
        if (_refreshing) return;
        _refreshing = true;
        _window.SetBusy(true);
        try
        {
            var snapshots = new List<QuotaSnapshot>();
            foreach (var provider in _providers)
            {
                if (provider is OpenAiUsageProvider &&
                    string.IsNullOrWhiteSpace(WindowsCredentialStore.Read(OpenAiUsageProvider.CredentialId)))
                    continue;
                if (provider is GitHubCopilotProvider &&
                    (GitHubConnectionSettings.Load() is null ||
                     string.IsNullOrWhiteSpace(WindowsCredentialStore.Read(GitHubCopilotProvider.CredentialId))))
                    continue;
                snapshots.AddRange(await provider.RefreshAsync(CancellationToken.None));
            }
            _snapshots = snapshots;
            _window.ShowSnapshots(snapshots);
            UpdateConnectionStates();
            _overlay.ShowSnapshots(snapshots);
            CheckNotifications();
        }
        catch (Exception ex)
        {
            _window.ShowError(ex.Message);
        }
        finally
        {
            _window.SetBusy(false);
            _refreshing = false;
        }
    }

    private void UpdateConnectionStates()
    {
        try
        {
            _window.SetConnectionStates(
                !string.IsNullOrWhiteSpace(WindowsCredentialStore.Read(OpenAiUsageProvider.CredentialId)),
                GitHubConnectionSettings.Load() is not null &&
                !string.IsNullOrWhiteSpace(WindowsCredentialStore.Read(GitHubCopilotProvider.CredentialId)));
        }
        catch (Exception ex) { _window.ShowError(ex.Message); }
    }

    private void CheckNotifications()
    {
        if (!_settings.NotificationsEnabled) return;
        try
        {
            _notifier.Check(ManualTrackerStore.Load(), _settings.NotifyBeforeMinutes,
                (title, message) => _tray.ShowBalloonTip(5000, title, message, ToolTipIcon.Info));
        }
        catch (Exception ex) { _window.ShowError("Notification state: " + ex.Message); }
    }

    private void ToggleOverlay()
    {
        if (_overlay.Visible)
        {
            _overlay.Hide();
            _window.SetOverlayVisible(false);
        }
        else
        {
            _overlay.TopMost = _settings.OverlayTopMost;
            _overlay.ShowSnapshots(_snapshots);
            _overlay.Show();
            _window.SetOverlayVisible(true);
        }
    }

    private void ResetOverlayPosition()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1200, 800);
        _overlay.Location = new Point(area.Right - _overlay.Width - 20, area.Top + 20);
        _settings = _settings with { OverlayX = _overlay.Left, OverlayY = _overlay.Top };
        try { _settings.Save(); }
        catch (IOException ex) { _window.ShowError("บันทึกตำแหน่งไม่ได้: " + ex.Message); }
    }

    private void OpenSettings()
    {
        bool startupEnabled;
        try { startupEnabled = StartupRegistration.IsEnabled(); }
        catch (Exception ex)
        {
            _window.ShowError("Startup setting: " + ex.Message);
            return;
        }
        using var dialog = new SettingsForm(_settings, startupEnabled);
        if (dialog.ShowDialog(_window) != DialogResult.OK) return;
        try
        {
            StartupRegistration.SetEnabled(dialog.StartupEnabled);
            _settings = dialog.GetSettings(_settings);
            _settings.Save();
            _overlay.TopMost = _settings.OverlayTopMost;
            _refreshTimer.Interval = _settings.RefreshMinutes * 60_000;
            CheckNotifications();
        }
        catch (Exception ex) { _window.ShowError("Could not save settings: " + ex.Message); }
    }

    private void ConnectOpenAi()
    {
        using var dialog = new Form
        {
            Text = "เชื่อมต่อ OpenAI API ขั้นสูง",
            Width = 440,
            Height = 190,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false
        };
        var explanation = new Label
        {
            Text = "ใช้เฉพาะผู้ดูแลบัญชี OpenAI API ระดับองค์กร\nผู้ใช้ ChatGPT หรือ Codex ทั่วไปไม่ต้องใช้คีย์นี้",
            Left = 16, Top = 14, Width = 390, Height = 45
        };
        var input = new TextBox { Left = 16, Top = 68, Width = 390, UseSystemPasswordChar = true };
        var save = new Button { Text = "บันทึก", Left = 316, Top = 105, Width = 90, Height = 36, DialogResult = DialogResult.OK };
        dialog.Controls.AddRange([explanation, input, save]);
        dialog.AcceptButton = save;
        if (dialog.ShowDialog(_window) != DialogResult.OK || string.IsNullOrWhiteSpace(input.Text)) return;
        try
        {
            WindowsCredentialStore.Save(OpenAiUsageProvider.CredentialId, input.Text.Trim());
            _ = RefreshAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(_window, "Could not save the credential: " + ex.Message,
                "AI Quota Monitor", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { input.Clear(); }
    }

    private void DisconnectOpenAi()
    {
        try
        {
            WindowsCredentialStore.Delete(OpenAiUsageProvider.CredentialId);
            _ = RefreshAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(_window, "Could not remove the credential: " + ex.Message,
                "AI Quota Monitor", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void AddManualTracker()
    {
        using var dialog = new Form
        {
            Text = "เพิ่มเวลารีเซ็ต", Width = 420, Height = 230,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false
        };
        var name = new ComboBox
        {
            Left = 20, Top = 38, Width = 365,
            DropDownStyle = ComboBoxStyle.DropDown
        };
        name.Items.AddRange([
            "ChatGPT / Codex", "Claude / Claude Code", "Gemini", "GitHub Copilot",
            "Perplexity", "Grok", "Cursor", "Poe", "Microsoft Copilot"
        ]);
        var date = new DateTimePicker
        {
            Left = 20, Top = 92, Width = 345,
            Format = DateTimePickerFormat.Custom,
            CustomFormat = "dd MMM yyyy  HH:mm",
            Value = DateTime.Now.AddHours(5)
        };
        var save = new Button { Text = "เพิ่มรายการ", Left = 285, Top = 158, Width = 100, Height = 36, DialogResult = DialogResult.OK };
        dialog.Controls.AddRange([
            new Label { Text = "บริการ AI (เลือกหรือพิมพ์ชื่อ)", Left = 20, Top = 14, AutoSize = true }, name,
            new Label { Text = "วันและเวลารีเซ็ตถัดไป (เวลาท้องถิ่น)", Left = 20, Top = 86, AutoSize = true }, date,
            save
        ]);
        dialog.AcceptButton = save;
        if (dialog.ShowDialog(_window) != DialogResult.OK) return;
        if (string.IsNullOrWhiteSpace(name.Text) || date.Value <= DateTime.Now)
        {
            MessageBox.Show(_window, "เลือกบริการและระบุเวลาในอนาคต");
            return;
        }
        try
        {
            var trackers = ManualTrackerStore.Load();
            trackers.Add(new ManualTracker(Guid.NewGuid().ToString("N"), name.Text.Trim(),
                new DateTimeOffset(date.Value)));
            ManualTrackerStore.Save(trackers);
            _ = RefreshAsync();
        }
        catch (IOException ex) { _window.ShowError(ex.Message); }
    }

    private void RemoveManualTracker(string id)
    {
        var trackers = ManualTrackerStore.Load();
        if (trackers.Count == 0) return;
        try
        {
            trackers.RemoveAll(tracker => tracker.Id == id);
            ManualTrackerStore.Save(trackers);
            _ = RefreshAsync();
        }
        catch (IOException ex) { _window.ShowError(ex.Message); }
    }

    private void ConnectGitHub()
    {
        using var dialog = new Form
        {
            Text = "เชื่อมต่อ GitHub Copilot", Width = 440, Height = 250,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false
        };
        var userName = new TextBox { Left = 20, Top = 38, Width = 390, PlaceholderText = "GitHub username" };
        var token = new TextBox { Left = 20, Top = 105, Width = 390, UseSystemPasswordChar = true };
        var save = new Button { Text = "เชื่อมต่อ", Left = 320, Top = 165, Width = 90, Height = 36, DialogResult = DialogResult.OK };
        dialog.Controls.AddRange([
            new Label { Text = "ชื่อผู้ใช้ GitHub", Left = 20, Top = 18, AutoSize = true }, userName,
            new Label { Text = "Fine-grained token ที่มีสิทธิ์ Plan: Read", Left = 20, Top = 85, AutoSize = true }, token,
            save
        ]);
        dialog.AcceptButton = save;
        if (dialog.ShowDialog(_window) != DialogResult.OK) return;
        if (string.IsNullOrWhiteSpace(userName.Text) || string.IsNullOrWhiteSpace(token.Text))
        {
            MessageBox.Show(_window, "Enter a username and a read-only Plan token.");
            return;
        }
        try
        {
            WindowsCredentialStore.Save(GitHubCopilotProvider.CredentialId, token.Text.Trim());
            new GitHubConnectionSettings(userName.Text.Trim()).Save();
            _ = RefreshAsync();
        }
        catch (Exception ex) { _window.ShowError("Could not connect GitHub: " + ex.Message); }
        finally { token.Clear(); }
    }

    private void DisconnectGitHub()
    {
        try
        {
            WindowsCredentialStore.Delete(GitHubCopilotProvider.CredentialId);
            GitHubConnectionSettings.Delete();
            _ = RefreshAsync();
        }
        catch (Exception ex) { _window.ShowError("Could not disconnect GitHub: " + ex.Message); }
    }

    private void Quit()
    {
        _quitting = true;
        _refreshTimer.Stop();
        _minuteTimer.Stop();
        _tray.Visible = false;
        _tray.Dispose();
        _overlay.Close();
        _window.Close();
        ExitThread();
    }
}

internal sealed class MonitorForm : Form
{
    private readonly FlowLayoutPanel _cards;
    private readonly Panel _emptyState;
    private readonly Label _status;
    private readonly Label _summary;
    private readonly Label _openAiStatus;
    private readonly Label _githubStatus;
    private readonly Button _refresh;
    private readonly Button _addManual;
    private readonly Button _overlayButton;
    private readonly Button _settingsButton;
    private readonly Panel _overviewPage;
    private readonly Panel _servicesPage;
    private readonly Button _overviewTab;
    private readonly Button _servicesTab;
    private readonly Panel _tabIndicator;

    public event EventHandler? RefreshRequested;
    public event EventHandler? ConnectRequested;
    public event EventHandler? DisconnectRequested;
    public event EventHandler? AddManualRequested;
    public event Action<string>? RemoveManualRequested;
    public event EventHandler? ConnectGitHubRequested;
    public event EventHandler? DisconnectGitHubRequested;
    public event EventHandler? OverlayRequested;
    public event EventHandler? SettingsRequested;

    public MonitorForm()
    {
        Text = "AI Quota Monitor";
        Width = 820;
        Height = 600;
        MinimumSize = new Size(680, 580);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = UiPalette.Background;
        ForeColor = UiPalette.Foreground;
        Font = UiPalette.BodyFont;

        var header = new Panel { Dock = DockStyle.Top, Height = 82, Padding = new Padding(24, 12, 24, 8), BackColor = UiPalette.Background };
        header.Controls.Add(new Label
        {
            Text = "AI Quota Monitor", AutoSize = true,
            Font = UiPalette.TitleFont, ForeColor = UiPalette.Foreground,
            Location = new Point(24, 8)
        });
        header.Controls.Add(new Label
        {
            Text = "ดูเวลารีเซ็ตและการใช้โควตา AI ได้ในที่เดียว", AutoSize = true,
            Font = UiPalette.BodyFont, ForeColor = UiPalette.MutedText,
            Location = new Point(26, 46)
        });
        _settingsButton = CreateButton("ตั้งค่า", 112, 40);
        _settingsButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _settingsButton.Location = new Point(Width - 156, 20);
        _settingsButton.Click += (_, _) => SettingsRequested?.Invoke(this, EventArgs.Empty);
        header.Resize += (_, _) => _settingsButton.Left = header.ClientSize.Width - _settingsButton.Width - 24;
        header.Controls.Add(_settingsButton);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Top, Height = 60, Padding = new Padding(24, 8, 24, 8),
            BackColor = UiPalette.Background, WrapContents = false, FlowDirection = FlowDirection.LeftToRight
        };
        _addManual = CreateButton("เพิ่มเวลารีเซ็ต", 158, 40, primary: true);
        _addManual.Click += (_, _) => AddManualRequested?.Invoke(this, EventArgs.Empty);
        _overlayButton = CreateButton("แสดงโอเวอร์เลย์", 142, 40);
        _overlayButton.Click += (_, _) => OverlayRequested?.Invoke(this, EventArgs.Empty);
        _refresh = CreateButton("รีเฟรช", 100, 40);
        _refresh.Click += (_, _) => RefreshRequested?.Invoke(this, EventArgs.Empty);
        actions.Controls.AddRange([_addManual, _overlayButton, _refresh]);

        var tabBar = new Panel { Dock = DockStyle.Top, Height = 44, BackColor = UiPalette.Background };
        _overviewTab = CreateButton("ภาพรวม", 118, 36);
        _overviewTab.Location = new Point(24, 3);
        _overviewTab.FlatAppearance.BorderSize = 0;
        _overviewTab.Click += (_, _) => SelectPage(false);
        _servicesTab = CreateButton("การเชื่อมต่อ", 118, 36);
        _servicesTab.Location = new Point(142, 3);
        _servicesTab.FlatAppearance.BorderSize = 0;
        _servicesTab.Click += (_, _) => SelectPage(true);
        _tabIndicator = new Panel { Width = 46, Height = 2, BackColor = UiPalette.Accent, Location = new Point(60, 41) };
        tabBar.Controls.AddRange([_overviewTab, _servicesTab, _tabIndicator]);

        _overviewPage = new Panel { Dock = DockStyle.Fill, BackColor = UiPalette.Background };
        _servicesPage = new Panel { Dock = DockStyle.Fill, BackColor = UiPalette.Background };
        var content = new Panel { Dock = DockStyle.Fill, BackColor = UiPalette.Background };

        var summaryBar = new Panel { Dock = DockStyle.Top, Height = 62, Padding = new Padding(24, 18, 24, 8), BackColor = UiPalette.Background };
        _summary = new Label { Text = "กำลังโหลดข้อมูล...", Dock = DockStyle.Fill, ForeColor = UiPalette.SecondaryText, Font = UiPalette.HeadingFont };
        summaryBar.Controls.Add(_summary);
        _cards = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false,
            AutoScroll = true, Padding = new Padding(20, 8, 20, 16), BackColor = UiPalette.Background
        };
        _cards.Resize += (_, _) => ResizeCards();
        _emptyState = BuildEmptyState();
        _overviewPage.Controls.Add(_cards);
        _overviewPage.Controls.Add(_emptyState);
        _overviewPage.Controls.Add(summaryBar);

        _openAiStatus = new Label();
        _githubStatus = new Label();
        _servicesPage.Controls.Add(BuildConnectionsPage());
        _servicesPage.Visible = false;
        content.Controls.Add(_overviewPage);
        content.Controls.Add(_servicesPage);

        _status = new Label
        {
            Text = "พร้อมทำงาน", Dock = DockStyle.Bottom, Height = 30,
            Padding = new Padding(24, 6, 8, 0), ForeColor = UiPalette.MutedText,
            BackColor = UiPalette.Background
        };
        Controls.Add(content);
        Controls.Add(tabBar);
        Controls.Add(_status);
        Controls.Add(actions);
        Controls.Add(header);
        AcceptButton = _addManual;
        SelectPage(false);
    }

    public void SetBusy(bool busy)
    {
        _refresh.Enabled = !busy;
        _refresh.Text = busy ? "กำลังโหลด..." : "รีเฟรช";
    }

    private void SelectPage(bool showServices)
    {
        _overviewPage.Visible = !showServices;
        _servicesPage.Visible = showServices;
        (showServices ? _servicesPage : _overviewPage).BringToFront();
        _overviewTab.BackColor = showServices ? UiPalette.Background : UiPalette.Surface;
        _overviewTab.ForeColor = showServices ? UiPalette.MutedText : UiPalette.Foreground;
        _servicesTab.BackColor = showServices ? UiPalette.Surface : UiPalette.Background;
        _servicesTab.ForeColor = showServices ? UiPalette.Foreground : UiPalette.MutedText;
        _tabIndicator.Left = showServices ? 178 : 60;
    }

    public void SetOverlayVisible(bool visible) => _overlayButton.Text = visible ? "ซ่อนโอเวอร์เลย์" : "แสดงโอเวอร์เลย์";

    public void SetConnectionStates(bool openAiConnected, bool githubConnected)
    {
        SetConnectionState(_openAiStatus, openAiConnected, "ไม่ได้เชื่อมต่อ", "เชื่อมต่อแล้ว");
        SetConnectionState(_githubStatus, githubConnected, "ไม่ได้เชื่อมต่อ", "เชื่อมต่อแล้ว");
        SetConnectionButtons("openai", openAiConnected, "เชื่อมต่อ API", "เปลี่ยน API key");
        SetConnectionButtons("github", githubConnected, "เชื่อมต่อ GitHub", "เปลี่ยนโทเค็น");
    }

    private void SetConnectionButtons(string id, bool connected, string connectText, string changeText)
    {
        if (_servicesPage.Controls.Find($"{id}-connect", true).FirstOrDefault() is Button connect)
            connect.Text = connected ? changeText : connectText;
        if (_servicesPage.Controls.Find($"{id}-disconnect", true).FirstOrDefault() is Button disconnect)
            disconnect.Enabled = connected;
    }

    public void ShowError(string message)
    {
        _status.ForeColor = UiPalette.Error;
        _status.Text = "เกิดข้อผิดพลาด: " + message;
    }

    public void ShowSnapshots(IReadOnlyList<QuotaSnapshot> snapshots)
    {
        _cards.SuspendLayout();
        _cards.Controls.Clear();
        foreach (var snapshot in snapshots) _cards.Controls.Add(BuildQuotaCard(snapshot));
        _cards.ResumeLayout();
        _emptyState.Visible = snapshots.Count == 0;
        _cards.Visible = snapshots.Count > 0;

        if (snapshots.Count == 0)
            _summary.Text = "เริ่มต้นติดตามรอบรีเซ็ตของบริการ AI ที่คุณใช้";
        else
        {
            var count = snapshots.Count;
            var next = snapshots.Where(item => item.ResetsAt > DateTimeOffset.Now)
                .OrderBy(item => item.ResetsAt).FirstOrDefault();
            _summary.Text = next is null
                ? $"กำลังติดตาม {count} รายการ"
                : $"กำลังติดตาม {count} รายการ     รอบถัดไป: {next.ProviderName} · {next.ResetsAt!.Value.LocalDateTime:g}";
        }
        _status.ForeColor = UiPalette.MutedText;
        _status.Text = $"อัปเดตล่าสุด {DateTime.Now:HH:mm} · ข้อมูลแต่ละรายการระบุแหล่งที่มาไว้แล้ว";
    }

    private Panel BuildEmptyState()
    {
        var panel = new Panel { Dock = DockStyle.Fill, BackColor = UiPalette.Background };
        var surface = new Panel
        {
            Width = 500, Height = 230, BackColor = UiPalette.Surface,
            Anchor = AnchorStyles.None, Padding = new Padding(28), BorderStyle = BorderStyle.FixedSingle
        };
        var title = new Label
        {
            Text = "ยังไม่มีรายการติดตาม", AutoSize = false, TextAlign = ContentAlignment.MiddleCenter,
            Font = UiPalette.TitleFont, ForeColor = UiPalette.Foreground,
            Left = 24, Top = 28, Width = 452, Height = 36
        };
        var description = new Label
        {
            Text = "เพิ่มเวลารีเซ็ตของบริการที่ใช้ได้เลย ไม่ต้องใส่รหัสผ่านหรือ API key\nหากบริการรองรับข้อมูลอย่างเป็นทางการ จึงค่อยเชื่อมบัญชีเพิ่มเติม",
            AutoSize = false, TextAlign = ContentAlignment.MiddleCenter,
            Font = UiPalette.BodyFont, ForeColor = UiPalette.SecondaryText,
            Left = 36, Top = 78, Width = 428, Height = 58
        };
        var add = CreateButton("เพิ่มเวลารีเซ็ต", 170, 42, primary: true);
        add.Left = 165;
        add.Top = 158;
        add.Click += (_, _) => AddManualRequested?.Invoke(this, EventArgs.Empty);
        surface.Controls.AddRange([title, description, add]);
        panel.Controls.Add(surface);
        panel.Resize += (_, _) => surface.Location = new Point(
            Math.Max(12, (panel.ClientSize.Width - surface.Width) / 2),
            Math.Max(12, (panel.ClientSize.Height - surface.Height) / 2));
        return panel;
    }

    private Control BuildConnectionsPage()
    {
        var list = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false,
            AutoScroll = true, Padding = new Padding(24, 10, 24, 10), BackColor = UiPalette.Background
        };
        list.Controls.Add(BuildConnectionCard("openai",
            "OpenAI API · ขั้นสูง", "สำหรับผู้ดูแลบัญชี OpenAI API ระดับองค์กรเท่านั้น",
            "ใช้ Admin API key เพื่อดู token ที่ใช้ในเดือนนี้ ไม่ใช่โควตา ChatGPT หรือ Codex",
            _openAiStatus, "เชื่อมต่อ API", ConnectRequested, "ยกเลิกการเชื่อมต่อ", DisconnectRequested));
        list.Controls.Add(BuildConnectionCard("github",
            "GitHub Copilot", "เชื่อมต่อบัญชี GitHub ส่วนตัวด้วย fine-grained token",
            "ต้องมีสิทธิ์ Plan: Read · แสดงเครดิตที่ใช้ รายงานไม่ได้บอกเครดิตคงเหลือหรือวันรีเซ็ต",
            _githubStatus, "เชื่อมต่อ GitHub", ConnectGitHubRequested, "ยกเลิกการเชื่อมต่อ", DisconnectGitHubRequested));
        list.Resize += (_, _) => LayoutConnectionCards(list);
        LayoutConnectionCards(list);
        return list;
    }

    private static void LayoutConnectionCards(FlowLayoutPanel list)
    {
        foreach (Control card in list.Controls)
        {
            card.Width = Math.Max(520, list.ClientSize.Width - 56);
            foreach (Control child in card.Controls)
            {
                if (child.Name == "connection-title") child.Width = card.Width - 225;
                else if (child.Name == "connection-state") child.Left = card.Width - 185;
                else if (child.Name is "connection-subtitle" or "connection-details")
                    child.Width = card.Width - 50;
            }
        }
    }

    private Control BuildConnectionCard(string id, string title, string subtitle, string details, Label state,
        string connectText, EventHandler? connectHandler, string disconnectText, EventHandler? disconnectHandler)
    {
        var card = new Panel
        {
            Width = 680, Height = 142, Margin = new Padding(0, 0, 0, 8),
            BackColor = UiPalette.Surface, BorderStyle = BorderStyle.FixedSingle
        };
        card.Controls.Add(new Panel { Dock = DockStyle.Left, Width = 4, BackColor = UiPalette.Accent });
        card.Controls.Add(new Label
        {
            Name = "connection-title", Text = title, Left = 20, Top = 12, Width = card.Width - 225, Height = 24,
            Font = UiPalette.HeadingFont, ForeColor = UiPalette.Foreground,
            AutoEllipsis = true
        });
        state.Name = "connection-state";
        state.Left = card.Width - 185;
        state.Top = 17;
        state.Width = 165;
        state.Height = 22;
        state.Font = UiPalette.BodyFont;
        card.Controls.Add(state);
        card.Controls.Add(new Label
        {
            Name = "connection-subtitle", Text = subtitle, Left = 20, Top = 40, Width = card.Width - 50, Height = 18,
            ForeColor = UiPalette.SecondaryText, AutoEllipsis = true, AutoSize = false
        });
        card.Controls.Add(new Label
        {
            Name = "connection-details", Text = details, Left = 20, Top = 63, Width = card.Width - 50, Height = 31,
            ForeColor = UiPalette.MutedText, AutoEllipsis = true, AutoSize = false
        });
        var connect = CreateButton(connectText, 150, 36, primary: true);
        connect.Name = $"{id}-connect";
        connect.Left = 20;
        connect.Top = 100;
        if (connectHandler is not null) connect.Click += connectHandler;
        var disconnect = CreateButton(disconnectText, 165, 36);
        disconnect.Name = $"{id}-disconnect";
        disconnect.Enabled = false;
        disconnect.Left = 184;
        disconnect.Top = 100;
        if (disconnectHandler is not null) disconnect.Click += disconnectHandler;
        card.Controls.AddRange([connect, disconnect]);
        return card;
    }

    private Control BuildQuotaCard(QuotaSnapshot snapshot)
    {
        var card = new Panel
        {
            Width = Math.Max(520, _cards.ClientSize.Width - 46), Height = 144,
            Margin = new Padding(4, 4, 4, 10), BackColor = UiPalette.Surface,
            BorderStyle = BorderStyle.FixedSingle
        };
        card.Controls.Add(new Panel { Dock = DockStyle.Left, Width = 4, BackColor = StateColor(snapshot.State) });
        var state = new Label
        {
            Name = "quota-state",
            Text = StateText(snapshot.State), TextAlign = ContentAlignment.MiddleRight,
            Font = UiPalette.BodyFont, ForeColor = StateColor(snapshot.State),
            Left = card.Width - 170, Top = 12, Width = 150, Height = 22, AutoEllipsis = true
        };
        var name = new Label
        {
            Name = "quota-title", Text = snapshot.ProviderName, Font = UiPalette.HeadingFont,
            ForeColor = UiPalette.Foreground, Left = 18, Top = 12,
            Width = card.Width - 205, Height = 24, AutoEllipsis = true
        };
        var metric = new Label
        {
            Name = "quota-metric", Text = snapshot.MetricName, Font = UiPalette.BodyFont,
            ForeColor = UiPalette.MutedText, Left = 18, Top = 42,
            Width = card.Width - 40, Height = 20, AutoEllipsis = true
        };
        var valueText = snapshot.Remaining.HasValue
            ? $"เหลือ {snapshot.Remaining:N0} {snapshot.Unit}"
            : snapshot.Used.HasValue
                ? $"ใช้ไป {snapshot.Used:N0} {snapshot.Unit} · โควตาคงเหลือไม่ทราบ"
                : "ยังไม่มีข้อมูลโควตาคงเหลือ";
        var value = new Label
        {
            Name = "quota-value", Text = valueText, Font = UiPalette.PrimaryValueFont,
            ForeColor = UiPalette.Foreground, Left = 18, Top = 64,
            Width = card.Width - 170, Height = 26, AutoEllipsis = true,
            AccessibleDescription = valueText
        };
        var resetText = snapshot.ResetsAt.HasValue
            ? $"รีเซ็ต {snapshot.ResetsAt.Value.LocalDateTime:dd MMM yyyy HH:mm}"
            : "เวลารีเซ็ตยังไม่ทราบ";
        var reset = new Label
        {
            Name = "quota-reset", Text = resetText, Font = UiPalette.BodyFont,
            ForeColor = UiPalette.SecondaryText, Left = 18, Top = 94,
            Width = card.Width - 40, Height = 20, AutoEllipsis = true,
            AccessibleDescription = resetText
        };
        var source = snapshot.Source == ValueSource.Manual ? "กรอกเอง" : "ข้อมูลจากผู้ให้บริการ";
        var detailText = $"{source} · ตรวจล่าสุด {snapshot.ObservedAt.LocalDateTime:HH:mm}" +
            (string.IsNullOrWhiteSpace(snapshot.Message) ? "" : $" · {snapshot.Message}");
        var detail = new Label
        {
            Name = "quota-detail", Text = detailText, Font = UiPalette.SmallFont,
            ForeColor = UiPalette.MutedText, Left = 18, Top = 118,
            Width = snapshot.Source == ValueSource.Manual ? card.Width - 155 : card.Width - 40,
            Height = 18, AutoEllipsis = true, AccessibleDescription = detailText
        };
        card.Controls.AddRange([name, state, metric, value, reset, detail]);
        if (snapshot.Source == ValueSource.Manual)
        {
            var remove = CreateButton("ลบรายการ", 110, 34, danger: true);
            remove.Left = card.Width - 132;
            remove.Top = 104;
            remove.Click += (_, _) => RemoveManualRequested?.Invoke(snapshot.ProviderId);
            card.Controls.Add(remove);
        }
        return card;
    }

    private static void SetConnectionState(Label label, bool connected, string disconnectedText, string connectedText)
    {
        label.Text = connected ? connectedText : disconnectedText;
        label.ForeColor = connected ? UiPalette.Accent : UiPalette.MutedText;
    }

    private static string StateText(ProviderState state) => state switch
    {
        ProviderState.Connected => "เชื่อมต่อแล้ว",
        ProviderState.Disconnected => "ไม่ได้เชื่อมต่อ",
        ProviderState.Unavailable => "ไม่มีข้อมูลจากบริการ",
        ProviderState.Error => "ดึงข้อมูลไม่สำเร็จ",
        _ => "ไม่ทราบสถานะ"
    };

    private static Color StateColor(ProviderState state) => state switch
    {
        ProviderState.Connected => UiPalette.Accent,
        ProviderState.Error => UiPalette.Error,
        _ => UiPalette.MutedText
    };

    private Button CreateButton(string text, int width, int height, bool primary = false, bool danger = false)
    {
        var button = new Button
        {
            Text = text, Width = width, Height = height, FlatStyle = FlatStyle.Flat,
            Font = UiPalette.ButtonFont,
            BackColor = primary ? UiPalette.Accent : UiPalette.SurfaceRaised,
            ForeColor = primary ? UiPalette.OnAccent : UiPalette.Foreground,
            AccessibleName = text, TabStop = true
        };
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = primary ? UiPalette.Accent : UiPalette.Border;
        if (danger)
        {
            button.BackColor = UiPalette.Surface;
            button.ForeColor = UiPalette.Error;
            button.FlatAppearance.BorderColor = UiPalette.Error;
        }
        var idleBorder = button.FlatAppearance.BorderColor;
        button.GotFocus += (_, _) => button.FlatAppearance.BorderColor = UiPalette.Foreground;
        button.LostFocus += (_, _) => button.FlatAppearance.BorderColor = idleBorder;
        return button;
    }

    private void ResizeCards()
    {
        foreach (Control card in _cards.Controls)
        {
            card.Width = Math.Max(520, _cards.ClientSize.Width - 46);
            foreach (Control child in card.Controls)
            {
                if (child.Name == "quota-title") child.Width = card.Width - 205;
                else if (child.Name == "quota-state") child.Left = card.Width - 170;
                else if (child.Name is "quota-metric" or "quota-reset") child.Width = card.Width - 40;
                else if (child.Name == "quota-value") child.Width = card.Width - 170;
                else if (child.Name == "quota-detail") child.Width = card.Width - 155;
                else if (child is Button button && button.Text == "ลบรายการ") button.Left = card.Width - 132;
            }
        }
    }
}
