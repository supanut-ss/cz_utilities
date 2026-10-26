using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using Microsoft.Win32;

namespace HWMonitor;

/// <summary>
/// LibreHardwareMonitor 0.9.6+ reads CPU MSRs and Super I/O chips through the PawnIO driver.
/// HW Monitor requires it, so it is installed with winget before the main window opens.
/// </summary>
internal static class PawnIo
{
    public const string WingetId = "namazso.PawnIO";
    public const string Homepage = "https://pawnio.eu/";

    public static bool IsInstalled =>
        Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\PawnIO") is not null;

    /// <summary>Shows the install dialog. Returns false if the user chose to exit.</summary>
    public static bool EnsureInstalled()
    {
        if (IsInstalled) return true;
        using var dialog = new PawnIoSetupForm();
        return dialog.ShowDialog() == DialogResult.OK;
    }

    public static async Task<(bool Ok, string Message)> InstallAsync()
    {
        var psi = new ProcessStartInfo("winget.exe")
        {
            ArgumentList =
            {
                "install", "--id", WingetId, "--exact", "--silent", "--source", "winget",
                "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
            },
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
        };

        Process proc;
        try
        {
            proc = Process.Start(psi)!;
        }
        catch (Win32Exception)
        {
            return (false, "winget (App Installer) was not found on this PC.");
        }

        using (proc)
        {
            var stdout = proc.StandardOutput.ReadToEndAsync();
            var stderr = proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();
            if (IsInstalled) return (true, "");

            // winget redraws progress with \r; keep the last few meaningful lines for the error message
            var lines = ((await stdout) + "\n" + (await stderr))
                .Split('\r', '\n')
                .Select(l => l.Trim())
                .Where(l => l.Length > 3 && l.Any(char.IsLetter))
                .TakeLast(3);
            return (false, $"winget exited with code 0x{proc.ExitCode:X8}.\n{string.Join("\n", lines)}");
        }
    }
}

/// <summary>Small blocking dialog that installs PawnIO and offers retry / manual download on failure.</summary>
internal sealed class PawnIoSetupForm : Form
{
    private static readonly Color Bg = Color.FromArgb(18, 25, 34);
    private static readonly Color Muted = Color.FromArgb(139, 152, 167);

    private readonly Label _title = new() { AutoSize = false, Dock = DockStyle.Top, Height = 34 };
    private readonly Label _detail = new() { AutoSize = false, Dock = DockStyle.Top, Height = 64 };
    private readonly ProgressBar _progress = new() { Dock = DockStyle.Top, Height = 6, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 25 };
    private readonly FlowLayoutPanel _buttons = new() { Dock = DockStyle.Bottom, Height = 44, FlowDirection = FlowDirection.RightToLeft, Visible = false };

    public PawnIoSetupForm()
    {
        Text = "HW Monitor";
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        ClientSize = new Size(500, 190);
        BackColor = Bg;
        ForeColor = Color.FromArgb(230, 237, 243);
        Padding = new Padding(22, 18, 22, 14);
        Font = new Font("Segoe UI", 9.5f);

        _title.Font = new Font("Segoe UI Semibold", 13f);
        _title.Text = "Installing PawnIO driver";
        _detail.ForeColor = Muted;
        _detail.Text = "HW Monitor needs the PawnIO driver to read CPU and motherboard temperatures and fan speeds. Installing it with winget…";

        _buttons.Controls.Add(MakeButton("Exit", (_, _) => { DialogResult = DialogResult.Cancel; Close(); }));
        _buttons.Controls.Add(MakeButton("Retry", async (_, _) => await RunInstallAsync()));
        _buttons.Controls.Add(MakeButton("Download page", (_, _) =>
            Process.Start(new ProcessStartInfo(PawnIo.Homepage) { UseShellExecute = true })));

        // Dock order: last added sits on top
        Controls.Add(_buttons);
        Controls.Add(_progress);
        Controls.Add(_detail);
        Controls.Add(_title);

        Shown += async (_, _) => await RunInstallAsync();
    }

    private static Button MakeButton(string text, EventHandler onClick)
    {
        var b = new Button
        {
            Text = text,
            AutoSize = true,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(23, 32, 41),
            ForeColor = Color.FromArgb(230, 237, 243),
            Padding = new Padding(8, 2, 8, 2),
            Margin = new Padding(8, 8, 0, 0),
        };
        b.FlatAppearance.BorderColor = Color.FromArgb(44, 57, 71);
        b.Click += onClick;
        return b;
    }

    private async Task RunInstallAsync()
    {
        _buttons.Visible = false;
        _progress.Visible = true;
        _title.Text = "Installing PawnIO driver";

        var (ok, message) = await PawnIo.InstallAsync();
        if (ok)
        {
            DialogResult = DialogResult.OK;
            Close();
            return;
        }

        _progress.Visible = false;
        _title.Text = "PawnIO could not be installed";
        _detail.Text = $"{message}\nRetry, or install it manually from pawnio.eu and start HW Monitor again.";
        _buttons.Visible = true;
    }
}
