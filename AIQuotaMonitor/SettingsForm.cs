using AIQuotaMonitor.Settings;

namespace AIQuotaMonitor;

internal sealed class SettingsForm : Form
{
    private readonly CheckBox _startup;
    private readonly CheckBox _minimized;
    private readonly CheckBox _overlayOnLaunch;
    private readonly CheckBox _topMost;
    private readonly CheckBox _notifications;
    private readonly NumericUpDown _notifyBefore;
    private readonly NumericUpDown _refreshMinutes;

    public SettingsForm(AppSettings settings, bool startupEnabled)
    {
        Text = "ตั้งค่าการทำงาน";
        Width = 470;
        Height = 420;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = UiPalette.Background;
        ForeColor = UiPalette.Foreground;
        Font = UiPalette.BodyFont;

        Controls.Add(new Label
        {
            Text = "การเริ่มทำงานและการแจ้งเตือน", Left = 24, Top = 18, Width = 400, Height = 30,
            Font = UiPalette.HeadingFont, ForeColor = UiPalette.Foreground
        });
        _startup = Check("เปิดแอพพร้อม Windows", startupEnabled, 62);
        _minimized = Check("เริ่มทำงานใน system tray", settings.StartMinimized, 98);
        _overlayOnLaunch = Check("แสดงโอเวอร์เลย์เมื่อเปิดแอพ", settings.ShowOverlayOnLaunch, 134);
        _topMost = Check("ให้โอเวอร์เลย์อยู่หน้าต่างอื่นเสมอ", settings.OverlayTopMost, 170);
        _notifications = Check("แจ้งเตือนก่อนถึงเวลารีเซ็ต", settings.NotificationsEnabled, 206);
        _notifyBefore = Number(settings.NotifyBeforeMinutes, 1, 120, 250);
        _refreshMinutes = Number(settings.RefreshMinutes, 1, 60, 294);
        Controls.Add(new Label { Text = "แจ้งเตือนล่วงหน้า (นาที)", Left = 28, Top = 251, Width = 225, ForeColor = UiPalette.SecondaryText });
        Controls.Add(new Label { Text = "ตรวจข้อมูลทุก (นาที)", Left = 28, Top = 295, Width = 225, ForeColor = UiPalette.SecondaryText });
        var save = new Button
        {
            Text = "บันทึก", Left = 342, Top = 344, Width = 90, Height = 40,
            BackColor = UiPalette.Accent, ForeColor = UiPalette.OnAccent,
            FlatStyle = FlatStyle.Flat,
            DialogResult = DialogResult.OK
        };
        save.FlatAppearance.BorderColor = UiPalette.Accent;
        var cancel = new Button
        {
            Text = "ยกเลิก", Left = 238, Top = 344, Width = 90, Height = 40,
            BackColor = UiPalette.SurfaceRaised, ForeColor = UiPalette.Foreground,
            FlatStyle = FlatStyle.Flat, DialogResult = DialogResult.Cancel
        };
        cancel.FlatAppearance.BorderColor = UiPalette.Border;
        Controls.Add(save);
        Controls.Add(cancel);
        AcceptButton = save;
        CancelButton = cancel;
    }

    public bool StartupEnabled => _startup.Checked;

    public AppSettings GetSettings(AppSettings previous) => previous with
    {
        StartMinimized = _minimized.Checked,
        ShowOverlayOnLaunch = _overlayOnLaunch.Checked,
        OverlayTopMost = _topMost.Checked,
        NotificationsEnabled = _notifications.Checked,
        NotifyBeforeMinutes = (int)_notifyBefore.Value,
        RefreshMinutes = (int)_refreshMinutes.Value
    };

    private CheckBox Check(string text, bool value, int top)
    {
        var box = new CheckBox
        {
            Text = text, Checked = value, Left = 28, Top = top, Width = 400, Height = 28,
            BackColor = UiPalette.Background, ForeColor = UiPalette.Foreground,
            UseVisualStyleBackColor = false, AccessibleName = text
        };
        Controls.Add(box);
        return box;
    }

    private NumericUpDown Number(int value, int min, int max, int top)
    {
        var number = new NumericUpDown
        {
            Left = 325, Top = top - 3, Width = 105, Height = 30,
            Minimum = min, Maximum = max,
            Value = Math.Clamp(value, min, max)
        };
        Controls.Add(number);
        return number;
    }
}
