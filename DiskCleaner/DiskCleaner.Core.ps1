# DiskCleaner.Core.ps1
# Shared engine, category catalog and helpers for DiskCleaner.ps1 (CLI) and
# DiskCleanerGui.ps1 (GUI). Dot-source it; it only defines types and functions.

$DiskCleanerCoreFile = $PSCommandPath

#region Engine ------------------------------------------------------------------
if (-not ('DiskCleaner.Engine' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace DiskCleaner
{
    public sealed class Target
    {
        public string Category;
        public string Root;
        public string Filter = "*";
        public bool Recurse = true;
        public DateTime CutoffUtc;

        // Move files to the Recycle Bin instead of deleting them. Files larger than
        // RecycleMaxBytes (0 = drive has no usable Recycle Bin) are left in place.
        public bool Recycle;
        public long RecycleMaxBytes;

        // Eligible files after a scan; deleted (or recycled) files after a clean.
        public long Files;
        public long Bytes;
        // Files in use or folders without access.
        public long Skipped;
        // Recycle mode only: files kept because the Recycle Bin cannot take them.
        public long NotRecycled;

        // Custom-folder and whole-drive mode: walk everything, but only take junk - files with a
        // junk name (*.tmp, crash dumps, Thumbs.db, ...) or anything inside a junk folder (Temp,
        // FOUND.000, shader/GPU caches, __pycache__, ...). Ordinary files are never touched.
        public bool JunkOnly;

        internal Regex Match;
    }

    // Moves files to the Recycle Bin through the shell. Callers must pre-check size, drive and
    // path length: for files the bin cannot take, the shell would delete them permanently.
    static class RecycleBin
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SHFILEOPSTRUCT64
        {
            public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
            public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 1)]
        struct SHFILEOPSTRUCT32
        {
            public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
            public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]
        static extern int SHFileOperation64(ref SHFILEOPSTRUCT64 op);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]
        static extern int SHFileOperation32(ref SHFILEOPSTRUCT32 op);

        const uint FO_DELETE = 3;
        // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI
        const ushort Flags = 0x0004 | 0x0010 | 0x0040 | 0x0200 | 0x0400;

        // Returns true when the shell reported no error for the whole batch.
        public static bool Send(ICollection<string> paths)
        {
            var from = new StringBuilder();
            foreach (var p in paths) from.Append(p).Append('\0'); // the marshaller adds the final terminator
            if (IntPtr.Size == 8)
            {
                var op = new SHFILEOPSTRUCT64 { wFunc = FO_DELETE, pFrom = from.ToString(), fFlags = Flags };
                return SHFileOperation64(ref op) == 0 && !op.fAnyOperationsAborted;
            }
            var op32 = new SHFILEOPSTRUCT32 { wFunc = FO_DELETE, pFrom = from.ToString(), fFlags = Flags };
            return SHFileOperation32(ref op32) == 0 && !op32.fAnyOperationsAborted;
        }
    }

    public static class Engine
    {
        static long processed;
        static CancellationTokenSource cts = new CancellationTokenSource();
        static readonly bool LongPaths = Directory.Exists(@"\\?\" + Environment.GetFolderPath(Environment.SpecialFolder.Windows));

        public static long Processed { get { return Interlocked.Read(ref processed); } }

        public static void Cancel() { cts.Cancel(); }

        public static Task Start(Target[] targets, int threads, bool delete)
        {
            cts = new CancellationTokenSource();
            Interlocked.Exchange(ref processed, 0);
            var job = new Job(targets, Math.Max(1, threads), delete, cts.Token);
            return Task.Factory.StartNew(() => job.Run(), TaskCreationOptions.LongRunning);
        }

        static bool IsOld(FileSystemInfo e, DateTime cutoffUtc)
        {
            // Creation time catches files just extracted with an old timestamp.
            return e.LastWriteTimeUtc < cutoffUtc && e.CreationTimeUtc < cutoffUtc;
        }

        static string ToLongPath(string path)
        {
            // A bare "D:" is drive-relative (resolves to that drive's last working directory, not
            // its root) everywhere in Windows, including the \\?\ namespace; make it "D:\" first.
            if (path.Length == 2 && path[1] == ':') path += '\\';
            return LongPaths && !path.StartsWith(@"\\") ? @"\\?\" + path : path;
        }

        static Regex WildcardToRegex(string pattern)
        {
            if (string.IsNullOrEmpty(pattern) || pattern == "*") return null;
            var rx = "^" + Regex.Escape(pattern).Replace(@"\*", ".*").Replace(@"\?", ".") + "$";
            return new Regex(rx, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }

        // One shared LIFO queue of directories for all targets: idle threads take
        // any pending directory, so a single huge folder still uses every thread.
        sealed class Job
        {
            readonly Target[] targets;
            readonly int threads;
            readonly bool delete;
            readonly CancellationToken token;
            // Item3: the folder is inside a junk folder (whole-drive mode).
            readonly ConcurrentStack<Tuple<Target, DirectoryInfo, bool>> work = new ConcurrentStack<Tuple<Target, DirectoryInfo, bool>>();
            readonly ConcurrentStack<string> oldDirs = new ConcurrentStack<string>();
            int pending;

            static readonly HashSet<string> ReservedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "$RECYCLE.BIN", "System Volume Information"
            };

            // Whole-drive mode: everything inside these folders is junk (names match case-insensitively).
            static readonly HashSet<string> JunkDirNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "Temp", "Tmp", "__pycache__", "CrashDumps", "D3DSCache", "ShaderCache", "GrShaderCache",
                "GPUCache", "Code Cache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache"
            };
            static readonly Regex JunkDirPattern = new Regex(@"^FOUND\.\d{3}$", RegexOptions.IgnoreCase); // chkdsk fragments

            // Whole-drive mode: junk files anywhere. Office owner files (~$x.docx) and macOS "._x" /
            // .DS_Store leftovers are only ever metadata; partial downloads are abandoned once old.
            static readonly Regex JunkFilePattern = new Regex(
                @"\.(tmp|temp|dmp|mdmp|hdmp|crdownload|partial)$|^(thumbs\.db|ehthumbs\.db|ehthumbs_vista\.db|\.ds_store)$|^~\$|^\._",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

            static bool IsJunkDir(string name) { return JunkDirNames.Contains(name) || JunkDirPattern.IsMatch(name); }

            public Job(Target[] targets, int threads, bool delete, CancellationToken token)
            {
                this.targets = targets;
                this.threads = threads;
                this.delete = delete;
                this.token = token;
            }

            public void Run()
            {
                foreach (var t in targets)
                {
                    t.Files = 0; t.Bytes = 0; t.Skipped = 0; t.NotRecycled = 0;
                    t.Match = WildcardToRegex(t.Filter);
                    try
                    {
                        var root = ToLongPath(t.Root);
                        if (File.Exists(root)) HandleFiles(t, new List<FileInfo> { new FileInfo(root) }, false);
                        else if (Directory.Exists(root))
                        {
                            // A folder the user pointed at that is itself a junk folder (e.g. a Temp folder) is all junk.
                            var name = Path.GetFileName(root.TrimEnd('\\'));
                            Push(t, new DirectoryInfo(root), t.JunkOnly && !string.IsNullOrEmpty(name) && IsJunkDir(name));
                        }
                    }
                    catch (Exception) { t.Skipped++; }
                }

                // STA threads: the shell's Recycle Bin operation expects a single-threaded apartment.
                var workers = new Thread[threads];
                for (int i = 0; i < threads; i++)
                {
                    workers[i] = new Thread(Worker) { IsBackground = true };
                    workers[i].SetApartmentState(ApartmentState.STA);
                    workers[i].Start();
                }
                foreach (var w in workers) w.Join();

                if (delete) RemoveEmptyDirs();
            }

            void Push(Target t, DirectoryInfo dir, bool inJunk)
            {
                Interlocked.Increment(ref pending);
                work.Push(Tuple.Create(t, dir, inJunk));
            }

            void Worker()
            {
                Tuple<Target, DirectoryInfo, bool> item;
                while (Volatile.Read(ref pending) > 0 && !token.IsCancellationRequested)
                {
                    if (!work.TryPop(out item)) { Thread.Sleep(1); continue; }
                    // Children are pushed before this decrement, so pending never hits 0 early.
                    try { ProcessDir(item.Item1, item.Item2, item.Item3); }
                    finally { Interlocked.Decrement(ref pending); }
                }
            }

            void ProcessDir(Target t, DirectoryInfo dir, bool inJunk)
            {
                FileSystemInfo[] entries;
                try { entries = dir.GetFileSystemInfos(); }
                catch (Exception) { Interlocked.Increment(ref t.Skipped); return; }

                var files = new List<FileInfo>();
                foreach (var e in entries)
                {
                    if (token.IsCancellationRequested) return;
                    if ((e.Attributes & FileAttributes.ReparsePoint) != 0) continue; // never follow or delete links
                    var sub = e as DirectoryInfo;
                    if (sub == null) { files.Add((FileInfo)e); continue; }
                    if (!t.Recurse) continue;
                    // OS-reserved: never recurse into these, however they were reached (e.g. a
                    // custom folder rooted at an entire drive). The Recycle Bin category's own
                    // root already sits one level inside $Recycle.Bin, so this never blocks it.
                    if (ReservedNames.Contains(sub.Name)) continue;
                    // Whole-drive mode removes emptied folders only *inside* a junk folder; the junk
                    // folder itself (e.g. a game's Temp) and every ordinary folder stay.
                    if (delete && IsOld(sub, t.CutoffUtc) && (!t.JunkOnly || inJunk)) oldDirs.Push(sub.FullName);
                    Push(t, sub, inJunk || (t.JunkOnly && IsJunkDir(sub.Name)));
                }
                if (files.Count > 0 && !token.IsCancellationRequested) HandleFiles(t, files, inJunk);
            }

            void HandleFiles(Target t, List<FileInfo> files, bool inJunk)
            {
                var eligible = new List<FileInfo>();
                foreach (var f in files)
                {
                    Interlocked.Increment(ref processed);
                    if (!IsOld(f, t.CutoffUtc)) continue;
                    if (t.Match != null && !t.Match.IsMatch(f.Name)) continue;
                    if (t.JunkOnly && !inJunk && !JunkFilePattern.IsMatch(f.Name)) continue; // ordinary file
                    eligible.Add(f);
                }
                if (eligible.Count == 0) return;

                if (!delete) { foreach (var f in eligible) Count(t, f.Length); return; }
                if (t.Recycle) { RecycleFiles(t, eligible); return; }
                foreach (var f in eligible)
                {
                    long length = f.Length;
                    try
                    {
                        if (f.IsReadOnly) f.IsReadOnly = false;
                        f.Delete();
                        Count(t, length);
                    }
                    catch (Exception) { Interlocked.Increment(ref t.Skipped); }
                }
            }

            // One shell call per folder; if anything in the batch fails (usually a file in use),
            // the rest are retried one by one. Success is judged by whether the file is gone.
            void RecycleFiles(Target t, List<FileInfo> files)
            {
                var batch = new List<KeyValuePair<string, long>>();
                foreach (var f in files)
                {
                    var path = f.FullName.StartsWith(@"\\?\") ? f.FullName.Substring(4) : f.FullName;
                    // The shell cannot take long paths, and deletes for good what does not fit in the bin.
                    if (path.Length >= 260 || f.Length > t.RecycleMaxBytes) { Interlocked.Increment(ref t.NotRecycled); continue; }
                    batch.Add(new KeyValuePair<string, long>(path, f.Length));
                }
                if (batch.Count == 0) return;

                var paths = new List<string>();
                foreach (var b in batch) paths.Add(b.Key);
                if (!RecycleBin.Send(paths))
                    foreach (var b in batch)
                        if (File.Exists(b.Key)) RecycleBin.Send(new[] { b.Key });

                foreach (var b in batch)
                {
                    if (File.Exists(b.Key)) Interlocked.Increment(ref t.Skipped);
                    else Count(t, b.Value);
                }
            }

            static void Count(Target t, long length)
            {
                Interlocked.Increment(ref t.Files);
                Interlocked.Add(ref t.Bytes, length);
            }

            // Remove folders that became empty, deepest level first so parents empty out too.
            void RemoveEmptyDirs()
            {
                var levels = new SortedDictionary<int, List<string>>();
                foreach (var path in oldDirs)
                {
                    int depth = 0;
                    foreach (char c in path) if (c == '\\') depth++;
                    List<string> list;
                    if (!levels.TryGetValue(depth, out list)) levels[depth] = list = new List<string>();
                    list.Add(path);
                }

                var options = new ParallelOptions { MaxDegreeOfParallelism = threads };
                var depths = new List<int>(levels.Keys);
                for (int i = depths.Count - 1; i >= 0 && !token.IsCancellationRequested; i--)
                    Parallel.ForEach(levels[depths[i]], options, path =>
                    {
                        try { Directory.Delete(path, false); } catch (Exception) { } // not empty or in use
                    });
            }
        }
    }

    // GUI view models below are compiled here so the window needs only one Add-Type.

    // One category row; raises change notifications so the window updates live.
    public sealed class CategoryRow : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler PropertyChanged;

        public string Name { get; set; }
        public string Group { get; set; }
        public string Description { get; set; }
        public string Icon { get; set; }
        public bool CanOpen { get; set; }
        public bool IsCustom { get { return Group == "Custom"; } }

        bool isSelected, isAvailable = true;
        long files = -1, bytes = -1;
        string status = "", statusKind = "";
        double sizeRatio;

        public bool IsSelected
        {
            get { return isSelected; }
            set { if (isSelected == value) return; isSelected = value; Raise("IsSelected"); }
        }

        public bool IsAvailable
        {
            get { return isAvailable; }
            set { if (isAvailable == value) return; isAvailable = value; Raise("IsAvailable"); }
        }

        // -1 means "not scanned yet" and shows as blank.
        public long Files
        {
            get { return files; }
            set { if (files == value) return; files = value; Raise("Files"); Raise("FilesLabel"); }
        }

        public long Bytes
        {
            get { return bytes; }
            set { if (bytes == value) return; bytes = value; Raise("Bytes"); Raise("SizeText"); Raise("HasSize"); }
        }

        public string Status
        {
            get { return status; }
            set { if (status == value) return; status = value; Raise("Status"); }
        }

        // "", "warn", "muted", "success" or "error"; drives the status chip colors.
        public string StatusKind
        {
            get { return statusKind; }
            set { if (statusKind == value) return; statusKind = value; Raise("StatusKind"); }
        }

        // Size relative to the largest category, for the inline size bar.
        public double SizeRatio
        {
            get { return sizeRatio; }
            set { if (sizeRatio == value) return; sizeRatio = value; Raise("SizeRatio"); }
        }

        public bool HasSize { get { return bytes >= 0; } }
        public string SizeText { get { return bytes < 0 ? "" : FormatSize(bytes); } }
        public string FilesLabel { get { return files < 0 ? "" : files.ToString("N0") + (files == 1 ? " file" : " files"); } }

        public static string FormatSize(long b)
        {
            if (b >= 1L << 30) return (b / 1073741824.0).ToString("N2") + " GB";
            if (b >= 1L << 20) return (b / 1048576.0).ToString("N1") + " MB";
            return (b / 1024.0).ToString("N0") + " KB";
        }

        void Raise(string name)
        {
            var handler = PropertyChanged;
            if (handler != null) handler(this, new PropertyChangedEventArgs(name));
        }
    }

    // A titled group of rows with a select-all state and a size summary.
    public sealed class CategoryGroup : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler PropertyChanged;

        readonly ObservableCollection<CategoryRow> rows = new ObservableCollection<CategoryRow>();

        public string Key { get; set; }
        public string Title { get; set; }
        public bool IsCustom { get { return Key == "Custom"; } }
        public ObservableCollection<CategoryRow> Rows { get { return rows; } }

        public CategoryGroup()
        {
            rows.CollectionChanged += OnRowsChanged;
        }

        // true = all available rows selected, false = none, null = some.
        public bool? IsAllSelected
        {
            get
            {
                int available = 0, selected = 0;
                foreach (var r in rows) if (r.IsAvailable) { available++; if (r.IsSelected) selected++; }
                if (selected == 0) return false;
                return selected == available ? (bool?)true : null;
            }
            set
            {
                bool on = value ?? false;
                foreach (var r in rows) if (r.IsAvailable) r.IsSelected = on;
            }
        }

        public bool HasSelectable
        {
            get { foreach (var r in rows) if (r.IsAvailable) return true; return false; }
        }

        public bool IsEmpty { get { return rows.Count == 0; } }

        public string Summary
        {
            get
            {
                long bytes = 0;
                int available = 0, selected = 0;
                foreach (var r in rows)
                {
                    if (r.Bytes > 0) bytes += r.Bytes;
                    if (r.IsAvailable) { available++; if (r.IsSelected) selected++; }
                }
                return selected + " of " + available + " selected  \u00B7  " + CategoryRow.FormatSize(bytes) + " found";
            }
        }

        void OnRowsChanged(object sender, NotifyCollectionChangedEventArgs e)
        {
            if (e.NewItems != null) foreach (CategoryRow r in e.NewItems) r.PropertyChanged += OnRowChanged;
            if (e.OldItems != null) foreach (CategoryRow r in e.OldItems) r.PropertyChanged -= OnRowChanged;
            Refresh();
        }

        void OnRowChanged(object sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName == "IsSelected" || e.PropertyName == "IsAvailable" || e.PropertyName == "Bytes") Refresh();
        }

        void Refresh()
        {
            Raise("IsAllSelected"); Raise("HasSelectable"); Raise("IsEmpty"); Raise("Summary");
        }

        void Raise(string name)
        {
            var handler = PropertyChanged;
            if (handler != null) handler(this, new PropertyChangedEventArgs(name));
        }
    }

    public static class Native
    {
        // Used for the dark title bar (20) and caption color (35) on Windows 11.
        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern bool GetVolumeNameForVolumeMountPoint(string mountPoint, StringBuilder name, int size);

        // "{guid}" of the volume mounted at a root such as "C:\", or null.
        public static string VolumeGuid(string root)
        {
            var sb = new StringBuilder(64);
            if (!GetVolumeNameForVolumeMountPoint(root, sb, sb.Capacity)) return null;
            var s = sb.ToString();
            int a = s.IndexOf('{'), b = s.IndexOf('}');
            return a >= 0 && b > a ? s.Substring(a, b - a + 1) : null;
        }
    }
}
'@
}
#endregion

#region Categories --------------------------------------------------------------
function New-Category {
    param(
        [string]$Name,
        [string]$Group,
        [string[]]$Paths,
        [string]$Description = '',
        [string]$Filter = '*',
        [bool]$Recurse = $true,
        [bool]$Admin = $false,
        [string[]]$Services = @(),
        [bool]$NoAge = $false,
        [scriptblock]$CleanCmd = $null,
        [bool]$RunFirst = $false, # run CleanCmd before files are deleted
        [bool]$Recycle = $false   # move files to the Recycle Bin instead of deleting them
    )
    [pscustomobject]@{
        Name = $Name; Group = $Group; Paths = @($Paths | Where-Object { $_ }); Description = $Description
        Filter = $Filter; Recurse = $Recurse; Admin = $Admin; Services = $Services; NoAge = $NoAge
        CleanCmd = $CleanCmd; RunFirst = $RunFirst; Recycle = $Recycle; Status = ''
    }
}

function Get-SubDirectory([string]$Path) {
    try { [IO.Directory]::GetDirectories($Path) } catch { @() }
}

# Finds cache and log folders of Chromium-based desktop apps (Electron, WebView2, CEF).
# A Chromium profile root is recognised by its "Local State" file. Returns a hashtable:
# AI category name (or OtherAppCache) -> list of folders.
function Find-AppCacheDir {
    $L = $env:LOCALAPPDATA; $R = $env:APPDATA
    $rules = [ordered]@{
        ClaudeCache   = 'claude|anthropic'
        ChatGPTCache  = 'openai|chatgpt|codex'
        AIEditorCache = 'cursor|windsurf|antigravity|trae|kiro'
        CopilotCache  = 'copilot'
    }
    # Covered by AppCache / BrowserCache already, or part of Windows itself.
    $skip = '^(Code|discord|Opera Software\\.*)$|^Packages\\(MicrosoftWindows\.|Microsoft\.Windows\.)|^WindowsOobeAppHost\\'
    $cacheNames = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
        'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache'),
        [StringComparer]::OrdinalIgnoreCase)
    $rootOnlyNames = [System.Collections.Generic.HashSet[string]]::new([string[]]@('logs', 'CachedData', 'CachedExtensionVSIXs'),
        [StringComparer]::OrdinalIgnoreCase)

    # Profile roots live 1-2 levels below %APPDATA% / %LOCALAPPDATA%, or inside packaged (MSIX) apps.
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($base in $R, $L) {
        foreach ($d1 in Get-SubDirectory $base) {
            $candidates.Add($d1)
            foreach ($d2 in Get-SubDirectory $d1) { $candidates.Add($d2) }
        }
    }
    foreach ($pkg in Get-SubDirectory "$L\Packages") {
        $candidates.Add("$pkg\LocalState\EBWebView")
        foreach ($r1 in Get-SubDirectory "$pkg\LocalCache\Roaming") {
            $candidates.Add($r1)
            foreach ($r2 in Get-SubDirectory $r1) { foreach ($r3 in Get-SubDirectory $r2) { $candidates.Add($r3) } }
        }
    }

    $result = @{}
    foreach ($userData in $candidates) {
        if (-not [IO.File]::Exists("$userData\Local State")) { continue }
        $rel = if ($userData.StartsWith("$R\", 'OrdinalIgnoreCase')) { $userData.Substring($R.Length + 1) } else { $userData.Substring($L.Length + 1) }
        if ($rel -match $skip) { continue }
        # A packaged app can host another app's profile (e.g. Docker inside Claude's package): name it by the inner app.
        $appName = if ($rel -match '^Packages\\[^\\]+\\LocalCache\\Roaming\\(.+)$') { $Matches[1] } else { $rel }
        $category = 'OtherAppCache'
        foreach ($k in $rules.Keys) { if ($appName -match $rules[$k]) { $category = $k; break } }
        if (-not $result.ContainsKey($category)) { $result[$category] = [System.Collections.Generic.List[string]]::new() }

        foreach ($dir in Get-SubDirectory $userData) {
            $leaf = [IO.Path]::GetFileName($dir)
            if ($cacheNames.Contains($leaf) -or $rootOnlyNames.Contains($leaf)) { $result[$category].Add($dir); continue }
            if ($leaf -eq 'Shared Dictionary') { continue } # its "cache" is paired with a database; leave it to the app
            # Profiles (Default, ...) and Partitions\<name> hold their own caches.
            $inner = if ($leaf -eq 'Partitions') { foreach ($p in Get-SubDirectory $dir) { Get-SubDirectory $p } } else { Get-SubDirectory $dir }
            foreach ($sub in $inner) { if ($cacheNames.Contains([IO.Path]::GetFileName($sub))) { $result[$category].Add($sub) } }
        }
    }
    $result
}

# Built-in catalog. Groups: Core (safe, default), AI (AI and other desktop app caches),
# Dev (package caches), Deep (irreversible or slow).
function Get-CleanerCategory {
    $L = $env:LOCALAPPDATA; $R = $env:APPDATA; $W = $env:windir; $U = $env:USERPROFILE; $PD = $env:ProgramData
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $recycleBins = [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } |
        ForEach-Object { $_.Name + '$Recycle.Bin\' + $sid }
    $chromium = foreach ($browser in 'Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser') {
        foreach ($cache in 'Cache', 'Code Cache', 'GPUCache') { "$L\$browser\User Data\*\$cache" }
    }
    $apps = Find-AppCacheDir

    @(
        New-Category UserTemp      Core @([IO.Path]::GetTempPath()) 'Temporary files of your account'
        New-Category WindowsTemp   Core @("$W\Temp") 'Temporary files of Windows and installers' -Admin $true
        New-Category BrowserCache  Core (@($chromium) + "$L\Mozilla\Firefox\Profiles\*\cache2" + "$L\Microsoft\Windows\INetCache\IE") `
                                        'Chrome, Edge, Brave and Firefox web caches'
        New-Category AppCache      Core @("$R\Code\Cache", "$R\Code\CachedData", "$R\Code\CachedExtensionVSIXs", "$R\Code\Code Cache",
                                          "$R\Code\GPUCache", "$R\discord\Cache", "$R\discord\Code Cache", "$R\discord\GPUCache", "$L\Spotify\Data") `
                                        'VS Code, Discord and Spotify caches'
        New-Category ShaderCache   Core @("$L\D3DSCache", "$L\NVIDIA\DXCache", "$L\NVIDIA\GLCache", "$L\AMD\DxCache", "$L\AMD\DxcCache") `
                                        'DirectX / GPU shader caches (games rebuild them)'
        New-Category ThumbCache    Core @("$L\Microsoft\Windows\Explorer") 'Explorer thumbnail cache' -Filter 'thumbcache_*.db' -Recurse $false
        New-Category CrashDumps    Core @("$L\CrashDumps", "$L\Microsoft\Windows\WER") 'App crash dumps and error reports'
        New-Category SystemDumps   Core @("$W\Minidump", "$W\MEMORY.DMP", "$PD\Microsoft\Windows\WER") 'System memory dumps and error reports' -Admin $true
        New-Category WindowsUpdate Core @("$W\SoftwareDistribution\Download") 'Update packages that are already installed' -Admin $true -Services wuauserv, bits
        New-Category DeliveryOpt   Core @("$W\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache") `
                                        'Update files cached for sharing with other PCs' -Admin $true -CleanCmd { Delete-DeliveryOptimizationCache -Force }
        New-Category WindowsLogs   Core @("$W\Logs\CBS", "$W\Logs\DISM") 'Old Windows servicing logs (CBS, DISM)' -Admin $true

        # Close an app before cleaning its cache; files it holds open are skipped.
        New-Category ClaudeCache   AI (@($apps.ClaudeCache) + "$L\Claude\logs" + "$L\claude-cli-nodejs\Cache" +
                                       "$L\Packages\Claude_*\LocalCache\Local\claude-cli-nodejs\Cache") 'Claude desktop and Claude Code caches, old logs'
        New-Category ChatGPTCache  AI (@($apps.ChatGPTCache) + "$L\Packages\OpenAI.*\LocalCache\Local\*\Logs") 'ChatGPT and Codex desktop caches, old logs'
        New-Category AIEditorCache AI (@($apps.AIEditorCache) + "$L\cursor-updater") 'Cursor, Windsurf, Antigravity: caches, old logs, update leftovers'
        New-Category CopilotCache  AI @($apps.CopilotCache) 'Microsoft Copilot app caches, old logs'
        New-Category OtherAppCache AI @($apps.OtherAppCache) 'Other Electron / WebView apps (Docker, Postman, Steam, ...)'

        New-Category npm     Dev @("$L\npm-cache") 'npm package cache'
        New-Category Yarn    Dev @("$L\Yarn\Cache") 'Yarn package cache'
        New-Category pip     Dev @("$L\pip\Cache") 'pip package cache'
        New-Category NuGet   Dev @("$L\NuGet\v3-cache", "$L\NuGet\plugins-cache") 'NuGet HTTP cache'
        New-Category Gradle  Dev @("$U\.gradle\caches") 'Gradle dependency and build cache'
        New-Category GoBuild Dev @("$L\go-build") 'Go build cache'
        New-Category Cargo   Dev @("$U\.cargo\registry\cache") 'Cargo crate downloads'

        # Emptied before other files are cleaned, so files just moved to the bin are not lost with it.
        New-Category RecycleBin     Deep @($recycleBins) 'Everything in the Recycle Bin (any age)' -NoAge $true -RunFirst $true `
                                         -CleanCmd { Clear-RecycleBin -Force -ErrorAction SilentlyContinue }
        New-Category ComponentStore Deep @() 'Superseded Windows components via DISM (slow)' -Admin $true -CleanCmd {
            dism.exe /Online /Cleanup-Image /StartComponentCleanup
            if ($LASTEXITCODE) { throw "DISM exit code $LASTEXITCODE" }
        }
    )
}

# Roots that must never be emptied, even if a path resolves to them.
$DiskCleanerProtectedRoots = @("$env:SystemDrive\", $env:windir, "$env:windir\System32", $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA,
    $env:ProgramData, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
#endregion

#region Helpers -----------------------------------------------------------------
function Format-Size([double]$Bytes) {
    $sign = if ($Bytes -lt 0) { '-' } else { '' }
    $b = [Math]::Abs($Bytes)
    if ($b -ge 1GB) { return '{0}{1:N2} GB' -f $sign, ($b / 1GB) }
    if ($b -ge 1MB) { return '{0}{1:N1} MB' -f $sign, ($b / 1MB) }
    '{0}{1:N0} KB' -f $sign, ($b / 1KB)
}

function Test-IsAdmin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# "D:" (a bare drive letter, no backslash) is a *drive-relative* path in Windows: it resolves to
# that drive's last working directory (tracked per process, inherited from the parent console),
# not to its root. A category root can end up as "D:" after TrimEnd('\') below, so every function
# that turns a root into a real filesystem path must go through this first.
function ConvertTo-RootPath([string]$Path) {
    if ($Path -match '^[A-Za-z]:$') { "$Path\" } else { $Path }
}

function Resolve-CategoryPath($Category) {
    foreach ($p in $Category.Paths) {
        $p = ConvertTo-RootPath $p
        if ($p -match '[*?]') {
            Get-Item -Path $p -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
        } elseif ([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) {
            $p
        }
    }
}

function Test-SafeRoot([string]$Path) {
    $full = [IO.Path]::GetFullPath((ConvertTo-RootPath $Path)).TrimEnd('\')
    if ($full -match '^[A-Za-z]:$') {
        # A drive root is fine on its own, except the system drive, which is in the list below too.
        return $DiskCleanerProtectedRoots -notcontains $full
    }
    ($full.Length -gt 3) -and ($DiskCleanerProtectedRoots -notcontains $full)
}

# Stricter check for user-chosen folders: also nothing inside Windows or Program Files.
function Test-CustomRoot([string]$Path) {
    $full = [IO.Path]::GetFullPath((ConvertTo-RootPath $Path)).TrimEnd('\')
    if (-not (Test-SafeRoot $full)) { return $false }
    foreach ($p in $env:windir, $env:ProgramFiles, ${env:ProgramFiles(x86)}) {
        if ($p -and "$full\".StartsWith($p.TrimEnd('\') + '\', 'OrdinalIgnoreCase')) { return $false }
    }
    $true
}

# Largest file the Recycle Bin of $Path's drive accepts, in bytes; 0 when that drive has no
# usable Recycle Bin (removable or network drive, bin turned off, or disabled by policy).
function Get-RecycleBinLimit([string]$Path) {
    try {
        $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath((ConvertTo-RootPath $Path)))
        $drive = [IO.DriveInfo]::new($root)
        if ($drive.DriveType -ne 'Fixed') { return [long]0 }
    } catch { return [long]0 }
    $policy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer' -ErrorAction SilentlyContinue
    if ($policy -and $policy.PSObject.Properties['NoRecycleFiles'] -and $policy.NoRecycleFiles -eq 1) { return [long]0 }
    $guid = [DiskCleaner.Native]::VolumeGuid($root)
    $bin = if ($guid) { Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\$guid" -ErrorAction SilentlyContinue }
    if ($bin -and $bin.PSObject.Properties['NukeOnDelete'] -and $bin.NukeOnDelete -eq 1) { return [long]0 }
    if ($bin -and $bin.PSObject.Properties['MaxCapacity'] -and $bin.MaxCapacity -gt 0) { return [long]$bin.MaxCapacity * 1MB }
    [long]($drive.TotalSize * 0.05) # Windows' default size when the user never changed it
}

function Get-FreeBytes {
    [long](([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } |
        Measure-Object -Property TotalFreeSpace -Sum).Sum)
}

# Builds engine targets for the given categories. Sets Status = 'needs admin' on
# admin-only categories when not elevated; skips protected, duplicate and nested roots.
function New-TargetList {
    param([object[]]$Categories, [bool]$IsAdmin, [datetime]$CutoffUtc)
    $targets = [System.Collections.Generic.List[DiskCleaner.Target]]::new()
    $roots = [System.Collections.Generic.List[string]]::new()
    foreach ($c in $Categories) {
        $c.Status = ''
        if ($c.Admin -and -not $IsAdmin) { $c.Status = 'needs admin'; continue }
        foreach ($root in @(Resolve-CategoryPath $c)) {
            $root = $root.TrimEnd('\')
            if (-not (Test-SafeRoot $root)) { Write-Warning "Refusing protected path: $root"; continue }
            if ($roots | Where-Object { $root -eq $_ -or $root.StartsWith("$_\", 'OrdinalIgnoreCase') }) { continue }
            $roots.Add($root)

            $t = [DiskCleaner.Target]::new()
            $t.Category = $c.Name
            $t.Root = $root
            $t.Filter = $c.Filter
            $t.Recurse = $c.Recurse
            $t.CutoffUtc = if ($c.NoAge) { [DateTime]::MaxValue } else { $CutoffUtc }
            if ($c.Recycle) { $t.Recycle = $true; $t.RecycleMaxBytes = Get-RecycleBinLimit $root }
            # Folders and drives the user adds are only ever searched for junk, like the built-in
            # categories; ordinary files in them are never candidates, whatever the age filter says.
            $t.JunkOnly = $c.Group -eq 'Custom'
            $targets.Add($t)
        }
    }
    , $targets
}

function Wait-Engine([System.Threading.Tasks.Task]$Task, [string]$Activity) {
    try {
        while (-not $Task.Wait(250)) {
            Write-Progress -Activity $Activity -Status ('{0:N0} files checked' -f [DiskCleaner.Engine]::Processed)
        }
    } finally {
        if (-not $Task.IsCompleted) { [DiskCleaner.Engine]::Cancel() } # Ctrl+C
        Write-Progress -Activity $Activity -Completed
    }
}

function Get-Report([object[]]$Selected, [object[]]$Targets) {
    foreach ($c in $Selected) {
        $ts = @($Targets | Where-Object { $_.Category -eq $c.Name })
        $notRecycled = [long](($ts | Measure-Object -Property NotRecycled -Sum).Sum)
        $status = $c.Status
        if (-not $status -and -not $ts.Count) { $status = if ($c.CleanCmd) { 'size n/a' } else { 'not found' } }
        if (-not $status -and $c.Recycle) {
            $status = 'to Recycle Bin'
            if ($notRecycled) { $status += ", $notRecycled kept (too large or path too long)" }
        }
        [pscustomobject]@{
            Category    = $c.Name
            Group       = $c.Group
            Files       = [long](($ts | Measure-Object -Property Files -Sum).Sum)
            Bytes       = [long](($ts | Measure-Object -Property Bytes -Sum).Sum)
            Skipped     = [long](($ts | Measure-Object -Property Skipped -Sum).Sum)
            NotRecycled = $notRecycled
            Recycle     = [bool]$c.Recycle
            Status      = $status
        }
    }
}

# Runs RunFirst commands (emptying the Recycle Bin), deletes or recycles the file targets, then
# runs the other command-based categories (DISM, ...). Services of the given categories are
# stopped only while files are deleted. Returns a hashtable: category name -> command status.
function Invoke-Clean {
    param(
        [DiskCleaner.Target[]]$Targets,
        [object[]]$Categories,
        [int]$Threads,
        [hashtable]$Progress = @{}
    )
    $result = @{}
    $commands = @($Categories | Where-Object { $_.CleanCmd })
    foreach ($c in @($commands | Where-Object { $_.RunFirst })) { Invoke-CleanCommand $c $result $Progress }

    $stopped = [System.Collections.Generic.List[string]]::new()
    $services = @($Categories | ForEach-Object { $_.Services } | Select-Object -Unique)
    try {
        if ($services) { $Progress.Phase = 'Stopping services' }
        foreach ($name in $services) {
            $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
            if ($svc -and $svc.Status -eq 'Running') {
                Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
                $stopped.Add($name)
            }
        }
        $Progress.Phase = 'Cleaning files'
        Wait-Engine ([DiskCleaner.Engine]::Start($Targets, $Threads, $true)) 'Cleaning files'
    } finally {
        # Some services (BITS) take seconds to start; say so instead of looking stuck on "Cleaning files".
        if ($stopped.Count) { $Progress.Phase = 'Restarting services' }
        foreach ($name in $stopped) { Start-Service -Name $name -ErrorAction SilentlyContinue }
    }

    foreach ($c in @($commands | Where-Object { -not $_.RunFirst })) { Invoke-CleanCommand $c $result $Progress }
    $Progress.Phase = 'Done'
    $result
}

function Invoke-CleanCommand($Category, [hashtable]$Result, [hashtable]$Progress) {
    $Progress.Phase = "Running $($Category.Name)"
    Write-Host "Running $($Category.Name) cleanup..." -ForegroundColor Cyan
    try {
        # Rebuilt so it runs in this runspace (the GUI cleans in a background runspace).
        & ([scriptblock]::Create($Category.CleanCmd.ToString())) | Out-Host
        $Result[$Category.Name] = 'done'
    } catch {
        $Result[$Category.Name] = "failed: $($_.Exception.Message)"
    }
}

# Runs Invoke-Clean in a new runspace so a UI thread stays responsive.
# Poll .Handle.IsCompleted and .Sync.Phase; .PS.EndInvoke(.Handle) returns the result.
function Start-BackgroundClean {
    param([DiskCleaner.Target[]]$Targets, [object[]]$Categories, [int]$Threads)
    $sync = [hashtable]::Synchronized(@{ Phase = 'Starting' })
    $ps = [PowerShell]::Create()
    [void]$ps.AddScript(@'
param($CoreText, $Targets, $Categories, $Threads, $Sync)
$ErrorActionPreference = 'Stop'
. ([scriptblock]::Create($CoreText))
Invoke-Clean -Targets $Targets -Categories $Categories -Threads $Threads -Progress $Sync
'@)
    # Inside DiskCleaner.exe the core is only in memory ($DiskCleanerCoreText); otherwise read the file.
    $coreText = if ($DiskCleanerCoreText) { $DiskCleanerCoreText } else { [IO.File]::ReadAllText($DiskCleanerCoreFile) }
    [void]$ps.AddArgument($coreText).AddArgument($Targets).AddArgument(
        $Categories).AddArgument($Threads).AddArgument($sync)
    [pscustomobject]@{ PS = $ps; Handle = $ps.BeginInvoke(); Sync = $sync }
}

function Get-FolderBytes([string]$Path) {
    [long]$sum = 0
    try {
        foreach ($f in [IO.DirectoryInfo]::new($Path).EnumerateFiles('*', 'AllDirectories')) {
            if (-not ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $sum += $f.Length }
        }
    } catch { }
    $sum
}

# Big space users that need a human decision; reported, never touched.
function Get-SpaceHint {
    $L = $env:LOCALAPPDATA; $U = $env:USERPROFILE

    # Local AI models: large and re-downloaded only on purpose, so the user decides.
    $hfHome = if ($env:HF_HOME) { "$env:HF_HOME\hub" }
    $models = @(
        @{ Name = 'Ollama models'; Paths = @($env:OLLAMA_MODELS, "$U\.ollama\models")
           Advice = "Run 'ollama list' to see them and 'ollama rm <model>' to remove the ones you no longer use." }
        @{ Name = 'LM Studio models'; Paths = @("$U\.lmstudio\models", "$U\.cache\lm-studio\models")
           Advice = 'Delete unused models in LM Studio > My Models.' }
        @{ Name = 'Hugging Face model cache'; Paths = @($env:HF_HUB_CACHE, $hfHome, "$U\.cache\huggingface\hub")
           Advice = "Run 'huggingface-cli delete-cache' to pick which models to remove." }
    )
    foreach ($m in $models) {
        $path = $m.Paths | Where-Object { $_ -and [IO.Directory]::Exists($_) } | Select-Object -First 1
        if (-not $path) { continue }
        $bytes = Get-FolderBytes $path
        if ($bytes -gt 0) { "$($m.Name): $(Format-Size $bytes) in $path. $($m.Advice)" }
    }

    try {
        foreach ($f in [IO.DirectoryInfo]::new("$env:SystemDrive\").EnumerateFiles('hiberfil.sys')) {
            "hiberfil.sys is $(Format-Size $f.Length): 'powercfg /h off' (admin) if you never use hibernate/fast startup."
        }
    } catch { }
    if ([IO.Directory]::Exists("$env:SystemDrive\Windows.old")) {
        'Windows.old exists: Settings > System > Storage > Temporary files > Previous Windows installation(s).'
    }
    $vhdx = Get-ChildItem -Path "$L\Packages\*\LocalState\*.vhdx", "$L\wsl\*\*.vhdx", "$L\Docker\wsl\*\*.vhdx" -Force -ErrorAction SilentlyContinue
    foreach ($v in $vhdx) {
        "$($v.FullName) is $(Format-Size $v.Length): VHDX never shrinks; 'wsl --shutdown' then compact it (Optimize-VHD / diskpart 'compact vdisk')."
    }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        "Docker: 'docker system prune -a' removes unused images, containers and build cache."
    }
}
#endregion
