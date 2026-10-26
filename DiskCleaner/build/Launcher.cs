// Launcher.cs - DiskCleaner.exe.
//   DiskCleaner.exe                 opens the window (embedded DiskCleanerGui.ps1)
//   DiskCleaner.exe --cli [params]  runs the command-line tool (embedded DiskCleaner.ps1)
// The scripts are compiled in as resources and run from memory, so nothing is unpacked to a
// folder where another program could change it before an elevated run.
// Built by Build-Exe.ps1 with the .NET Framework compiler that ships with Windows.
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Runspaces;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Without this attribute the CLR uses .NET 4.0 behavior, which fails on paths over 260 characters.
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]
[assembly: AssemblyTitle("Disk Cleaner")]
[assembly: AssemblyProduct("Disk Cleaner")]
[assembly: AssemblyDescription("Find junk files and free up space safely")]
[assembly: AssemblyVersion("@VERSION@")]
[assembly: AssemblyFileVersion("@VERSION@")]

static class Program
{
    const string Usage =
@"Disk Cleaner - find junk files and free up space safely

  DiskCleaner.exe                  open the window
  DiskCleaner.exe --cli [options]  command line; scans only unless -Execute is given

Options:
  -Execute              delete the junk (asks first unless -Force)
  -Force                skip the confirmation and the separate scan pass
  -AiApps               also clean AI app caches (Claude, ChatGPT/Codex, Cursor, ...)
  -DevCaches            also clean npm, Yarn, pip, NuGet, Gradle, Go, Cargo caches
  -Deep                 also empty the Recycle Bin and run DISM cleanup (admin)
  -MinAgeDays <n>       only files not touched for n days (default 1)
  -Only <names>         only these categories, e.g. -Only UserTemp,npm
  -ExtraPath <folders>  also clean these folders (moved to the Recycle Bin)
  -PermanentDelete      delete -ExtraPath files permanently instead
  -Threads <n>          parallelism (use 1-2 on hard disks)
  -LogPath <file>       append a transcript of the run to this file

Output goes to the console that started the program. Run from a shell that waits for it,
for example: start /wait DiskCleaner.exe --cli ...  or  Start-Process -Wait ...
For the window: -Theme System|Light|Dark.
";

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBox(IntPtr hwnd, string text, string caption, uint type);
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int processId);
    [DllImport("kernel32.dll")] static extern bool AllocConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool SetStdHandle(int which, IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            var first = args[0].ToLowerInvariant();
            if (first == "--cli") return RunCli(args, 1);
            if (first == "--help" || first == "-h" || first == "/?") return RunCli(args, args.Length); // prints usage
        }
        return RunGui(args);
    }

    #region Window
    static int RunGui(string[] args)
    {
        Runspace runspace;
        try { runspace = CreateRunspace(null); }
        catch (Exception ex)
        {
            MessageBox(IntPtr.Zero, "Disk Cleaner could not start:\n\n" + ex.Message, "Disk Cleaner", 0x10); // MB_ICONERROR
            return 1;
        }

        using (runspace)
        using (var ps = PowerShell.Create())
        {
            ps.Runspace = runspace;
            ps.AddScript(Resource("DiskCleanerGui.ps1"));
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                var name = args[i].TrimStart('-', '/');
                if (name.Equals("Theme", StringComparison.OrdinalIgnoreCase) || name.Equals("SnapshotPath", StringComparison.OrdinalIgnoreCase))
                    ps.AddParameter(name, args[i + 1]);
            }
            try
            {
                ps.Invoke();
                return ps.HadErrors ? 1 : 0;
            }
            catch (RuntimeException)
            {
                return 1; // the script has already shown its own error message
            }
            catch (Exception ex)
            {
                MessageBox(IntPtr.Zero, "Disk Cleaner stopped unexpectedly:\n\n" + ex.Message, "Disk Cleaner", 0x10);
                return 1;
            }
        }
    }
    #endregion

    #region Command line
    static int RunCli(string[] args, int start)
    {
        ConnectConsole();
        if (start >= args.Length && args.Length > 0 && args[0].ToLowerInvariant() != "--cli")
        {
            Console.Out.Write(Usage);
            return 0;
        }

        var parameters = ParseParameters(args, start);
        if (parameters.ContainsKey("?") || parameters.ContainsKey("help"))
        {
            Console.Out.Write(Usage);
            return 0;
        }

        Runspace runspace;
        try { runspace = CreateRunspace(new CliHost()); }
        catch (Exception ex) { Console.Error.WriteLine("Disk Cleaner could not start: " + ex.Message); return 1; }

        using (runspace)
        using (var ps = PowerShell.Create())
        {
            ps.Runspace = runspace;
            ps.AddScript(Resource("DiskCleaner.ps1"));
            foreach (var p in parameters)
            {
                if (p.Value == null) ps.AddParameter(p.Key);                       // switch
                else if (p.Value.Count == 1) ps.AddParameter(p.Key, p.Value[0]);
                else ps.AddParameter(p.Key, p.Value.ToArray());
            }

            ConsoleCancelEventHandler onCancel = (s, e) => { e.Cancel = true; ps.BeginStop(null, null); };
            Console.CancelKeyPress += onCancel;
            try
            {
                var output = ps.Invoke();
                foreach (var o in output) if (o != null) Console.Out.WriteLine(o.ToString());
                foreach (var err in ps.Streams.Error) Console.Error.WriteLine("error: " + err);
                return ps.HadErrors ? 1 : 0;
            }
            catch (PipelineStoppedException) { Console.Error.WriteLine("Cancelled."); return 130; }
            catch (Exception ex) { Console.Error.WriteLine("error: " + ex.Message); return 1; }
            finally { Console.CancelKeyPress -= onCancel; }
        }
    }

    // "-Name" starts a parameter; the values after it (until the next "-Name") belong to it.
    // A parameter without values is a switch (stored as null). "-Name:value" is also accepted.
    static Dictionary<string, List<string>> ParseParameters(string[] args, int start)
    {
        var result = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        string current = null;
        for (int i = start; i < args.Length; i++)
        {
            var a = args[i];
            if (a.Length > 1 && (a[0] == '-' || a[0] == '/') && !char.IsDigit(a[1]))
            {
                var name = a.Substring(1);
                int colon = name.IndexOf(':');
                if (colon > 0)
                {
                    result[name.Substring(0, colon)] = new List<string> { name.Substring(colon + 1) };
                    current = null;
                }
                else
                {
                    result[name] = null;
                    current = name;
                }
            }
            else if (current != null)
            {
                if (result[current] == null) result[current] = new List<string>();
                result[current].Add(a);
            }
        }
        return result;
    }
    // A GUI-subsystem exe has no console. Attach to the parent's (or open one) and point the
    // standard handles at it, unless output is already redirected to a file or pipe.
    static void ConnectConsole()
    {
        if (!AttachConsole(-1)) AllocConsole();
        Redirect(-11, "CONOUT$", 0xC0000000); // STD_OUTPUT_HANDLE
        Redirect(-12, "CONOUT$", 0xC0000000); // STD_ERROR_HANDLE
        Redirect(-10, "CONIN$", 0xC0000000);  // STD_INPUT_HANDLE
        Console.SetOut(CreateWriter(Console.OpenStandardOutput()));
        Console.SetError(CreateWriter(Console.OpenStandardError()));
    }

    static void Redirect(int which, string device, uint access)
    {
        var h = GetStdHandle(which);
        if (h != IntPtr.Zero && h != new IntPtr(-1)) return; // already redirected or inherited
        var file = CreateFile(device, access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); // share read/write, OPEN_EXISTING
        if (!file.IsInvalid) SetStdHandle(which, file.DangerousGetHandle());
    }

    static StreamWriter CreateWriter(Stream stream)
    {
        return new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
    }
    #endregion

    static Runspace CreateRunspace(PSHost host)
    {
        var state = InitialSessionState.CreateDefault();
        state.ApartmentState = ApartmentState.STA;           // WPF needs STA
        state.ThreadOptions = PSThreadOptions.UseCurrentThread;
        var runspace = host == null ? RunspaceFactory.CreateRunspace(state) : RunspaceFactory.CreateRunspace(host, state);
        runspace.Open();
        runspace.SessionStateProxy.SetVariable("DiskCleanerCoreText", Resource("DiskCleaner.Core.ps1"));
        runspace.SessionStateProxy.SetVariable("DiskCleanerExe", Assembly.GetExecutingAssembly().Location);
        return runspace;
    }

    static string Resource(string name)
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        using (var reader = new StreamReader(stream, Encoding.UTF8))
            return reader.ReadToEnd();
    }
}

#region Console host
// Minimal host so Write-Host, Out-Host, Format-Table, Write-Warning and confirmation prompts
// reach the console.
sealed class CliHost : PSHost
{
    readonly CliUI ui = new CliUI();
    readonly Guid id = Guid.NewGuid();
    public override string Name { get { return "DiskCleaner"; } }
    public override Version Version { get { return new Version(1, 0); } }
    public override Guid InstanceId { get { return id; } }
    public override PSHostUserInterface UI { get { return ui; } }
    public override System.Globalization.CultureInfo CurrentCulture { get { return System.Globalization.CultureInfo.CurrentCulture; } }
    public override System.Globalization.CultureInfo CurrentUICulture { get { return System.Globalization.CultureInfo.CurrentUICulture; } }
    public override void SetShouldExit(int exitCode) { }
    public override void EnterNestedPrompt() { throw new NotSupportedException(); }
    public override void ExitNestedPrompt() { throw new NotSupportedException(); }
    public override void NotifyBeginApplication() { }
    public override void NotifyEndApplication() { }
}

sealed class CliUI : PSHostUserInterface
{
    readonly CliRawUI raw = new CliRawUI();
    public override PSHostRawUserInterface RawUI { get { return raw; } }

    static void WithColor(ConsoleColor fg, Action write)
    {
        ConsoleColor old = Console.ForegroundColor;
        bool changed = false;
        try { if (old != fg) { Console.ForegroundColor = fg; changed = true; } } catch (IOException) { }
        try { write(); }
        finally { if (changed) { try { Console.ForegroundColor = old; } catch (IOException) { } } }
    }

    public override void Write(string value) { Console.Out.Write(value); }
    public override void Write(ConsoleColor fg, ConsoleColor bg, string value) { WithColor(fg, () => Console.Out.Write(value)); }
    public override void WriteLine() { Console.Out.WriteLine(); }
    public override void WriteLine(string value) { Console.Out.WriteLine(value); }
    public override void WriteLine(ConsoleColor fg, ConsoleColor bg, string value) { WithColor(fg, () => Console.Out.WriteLine(value)); }
    public override void WriteDebugLine(string message) { Console.Error.WriteLine("debug: " + message); }
    public override void WriteVerboseLine(string message) { Console.Error.WriteLine("verbose: " + message); }
    public override void WriteWarningLine(string message) { WithColor(ConsoleColor.Yellow, () => Console.Error.WriteLine("warning: " + message)); }
    public override void WriteErrorLine(string message) { WithColor(ConsoleColor.Red, () => Console.Error.WriteLine(message)); }
    public override void WriteProgress(long sourceId, ProgressRecord record) { } // the scan is fast; no progress bar

    public override string ReadLine() { return Console.In.ReadLine(); }
    public override SecureString ReadLineAsSecureString() { throw new NotSupportedException(); }
    public override Dictionary<string, PSObject> Prompt(string caption, string message, Collection<FieldDescription> descriptions)
    {
        throw new NotSupportedException();
    }
    public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName) { throw new NotSupportedException(); }
    public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName,
        PSCredentialTypes allowedCredentialTypes, PSCredentialUIOptions options) { throw new NotSupportedException(); }

    // Used by $PSCmdlet.ShouldContinue: "[Y] Yes  [N] No". End of input counts as "No".
    public override int PromptForChoice(string caption, string message, Collection<ChoiceDescription> choices, int defaultChoice)
    {
        if (!string.IsNullOrEmpty(caption)) Console.Out.WriteLine(caption);
        if (!string.IsNullOrEmpty(message)) Console.Out.WriteLine(message);
        for (;;)
        {
            var labels = new StringBuilder();
            for (int i = 0; i < choices.Count; i++)
            {
                if (i > 0) labels.Append("  ");
                labels.Append('[').Append(Accelerator(choices[i])).Append("] ").Append(choices[i].Label.Replace("&", ""));
            }
            Console.Out.Write(labels + (defaultChoice >= 0 ? " (default " + Accelerator(choices[defaultChoice]) + "): " : ": "));
            var line = Console.In.ReadLine();
            if (line == null) return defaultChoice >= 0 ? defaultChoice : NoChoice(choices);
            line = line.Trim();
            if (line.Length == 0 && defaultChoice >= 0) return defaultChoice;
            for (int i = 0; i < choices.Count; i++)
                if (line.Equals(Accelerator(choices[i]), StringComparison.OrdinalIgnoreCase)) return i;
        }
    }

    static string Accelerator(ChoiceDescription c)
    {
        int at = c.Label.IndexOf('&');
        return at >= 0 && at + 1 < c.Label.Length ? c.Label.Substring(at + 1, 1) : c.Label.Substring(0, 1);
    }

    static int NoChoice(Collection<ChoiceDescription> choices)
    {
        for (int i = 0; i < choices.Count; i++) if (choices[i].Label.Replace("&", "").StartsWith("No", StringComparison.OrdinalIgnoreCase)) return i;
        return choices.Count - 1;
    }
}

sealed class CliRawUI : PSHostRawUserInterface
{
    static int Width()
    {
        try { return Math.Max(40, Console.BufferWidth); } catch (IOException) { return 120; }
    }

    public override ConsoleColor ForegroundColor
    {
        get { try { return Console.ForegroundColor; } catch (IOException) { return ConsoleColor.Gray; } }
        set { try { Console.ForegroundColor = value; } catch (IOException) { } }
    }
    public override ConsoleColor BackgroundColor
    {
        get { try { return Console.BackgroundColor; } catch (IOException) { return ConsoleColor.Black; } }
        set { try { Console.BackgroundColor = value; } catch (IOException) { } }
    }
    public override Size BufferSize { get { return new Size(Width(), 3000); } set { } }
    public override Size WindowSize { get { return new Size(Width(), 40); } set { } }
    public override Size MaxWindowSize { get { return new Size(Width(), 40); } }
    public override Size MaxPhysicalWindowSize { get { return new Size(Width(), 40); } }
    public override Coordinates CursorPosition { get { return new Coordinates(0, 0); } set { } }
    public override Coordinates WindowPosition { get { return new Coordinates(0, 0); } set { } }
    public override int CursorSize { get { return 25; } set { } }
    public override string WindowTitle { get { return "Disk Cleaner"; } set { } }
    public override bool KeyAvailable { get { return false; } }
    public override void FlushInputBuffer() { }
    public override KeyInfo ReadKey(ReadKeyOptions options) { throw new NotSupportedException(); }
    public override BufferCell[,] GetBufferContents(Rectangle rectangle) { throw new NotSupportedException(); }
    public override void ScrollBufferContents(Rectangle source, Coordinates destination, Rectangle clip, BufferCell fill) { throw new NotSupportedException(); }
    public override void SetBufferContents(Coordinates origin, BufferCell[,] contents) { throw new NotSupportedException(); }
    public override void SetBufferContents(Rectangle rectangle, BufferCell fill) { throw new NotSupportedException(); }
}
#endregion
