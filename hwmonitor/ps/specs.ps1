# Collects static hardware specs once and prints a single JSON document.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-MemType([int]$code) {
    switch ($code) {
        20 { 'DDR' } 21 { 'DDR2' } 24 { 'DDR3' } 26 { 'DDR4' }
        27 { 'LPDDR' } 28 { 'LPDDR2' } 29 { 'LPDDR3' } 30 { 'LPDDR4' }
        34 { 'DDR5' } 35 { 'LPDDR5' } default { $null }
    }
}

function Get-FormFactor([int]$code) {
    switch ($code) { 8 { 'DIMM' } 12 { 'SODIMM' } default { $null } }
}

function Decode-WmiString($arr) {
    if (-not $arr) { return $null }
    (($arr | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '').Trim()
}

# DXGI gives exact VRAM (Win32_VideoController.AdapterRAM caps at 4 GB) and the LUID
# needed to match GPU performance counters to a named adapter.
$dxgiSource = @'
using System;
using System.Runtime.InteropServices;
public static class Dxgi {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DESC1 {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision;
        public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public uint LuidLow; public int LuidHigh; public uint Flags;
    }
    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAdapter1 {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
        [PreserveSig] int GetDesc1(out DESC1 desc);
    }
    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFactory1 {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
        [PreserveSig] int EnumAdapters1(uint index, out IAdapter1 adapter);
    }
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);
    public static DESC1[] List() {
        var iid = typeof(IFactory1).GUID; object f;
        if (CreateDXGIFactory1(ref iid, out f) != 0) return new DESC1[0];
        var factory = (IFactory1)f; var list = new System.Collections.Generic.List<DESC1>();
        for (uint i = 0; ; i++) {
            IAdapter1 a; if (factory.EnumAdapters1(i, out a) != 0) break;
            DESC1 d; if (a.GetDesc1(out d) == 0) list.Add(d);
        }
        return list.ToArray();
    }
}
'@

$dxgi = @()
try {
    Add-Type -TypeDefinition $dxgiSource -ErrorAction Stop
    $dxgi = [Dxgi]::List() | Where-Object { ($_.Flags -band 2) -eq 0 }  # skip software adapters
} catch { }

$cs     = Get-CimInstance Win32_ComputerSystem
$os     = Get-CimInstance Win32_OperatingSystem
$bios   = Get-CimInstance Win32_BIOS
$board  = Get-CimInstance Win32_BaseBoard
$enc    = Get-CimInstance Win32_SystemEnclosure

# ---- CPU ----
$cpu = @(Get-CimInstance Win32_Processor | ForEach-Object {
    [ordered]@{
        name        = $_.Name.Trim()
        manufacturer= $_.Manufacturer
        cores       = $_.NumberOfCores
        threads     = $_.NumberOfLogicalProcessors
        baseClockMHz= $_.MaxClockSpeed
        l2KB        = $_.L2CacheSize
        l3KB        = $_.L3CacheSize
        socket      = $_.SocketDesignation
        architecture= switch ($_.Architecture) { 0 {'x86'} 9 {'x64'} 12 {'ARM64'} default {"$($_.Architecture)"} }
        virtualization = [bool]$_.VirtualizationFirmwareEnabled
        description = $_.Description
    }
})

# ---- Memory ----
$memModules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
    $type = Get-MemType $_.SMBIOSMemoryType
    if (-not $type) { $type = Get-MemType $_.MemoryType }
    [ordered]@{
        slot         = $_.DeviceLocator
        bank         = $_.BankLabel
        manufacturer = $_.Manufacturer
        partNumber   = "$($_.PartNumber)".Trim()
        capacity     = [int64]$_.Capacity
        speedMTs     = $_.Speed
        configuredMTs= $_.ConfiguredClockSpeed
        type         = $type
        formFactor   = Get-FormFactor $_.FormFactor
        voltage      = if ($_.ConfiguredVoltage) { $_.ConfiguredVoltage / 1000 } else { $null }
    }
})
$memArray = Get-CimInstance Win32_PhysicalMemoryArray | Select-Object -First 1

# ---- GPU ----
$videoCtl = @(Get-CimInstance Win32_VideoController)
$gpus = @()
if ($dxgi.Count -gt 0) {
    $seen = @{}
    foreach ($d in $dxgi) {
        $luid = ('luid_0x{0:X8}_0x{1:X8}' -f $d.LuidHigh, $d.LuidLow)
        if ($seen[$luid]) { continue }; $seen[$luid] = $true
        $vc = $videoCtl | Where-Object { $_.Name -eq $d.Description } | Select-Object -First 1
        $gpus += [ordered]@{
            name          = $d.Description
            vendorId      = ('0x{0:X4}' -f $d.VendorId)
            vram          = [int64][uint64]$d.DedicatedVideoMemory
            sharedMemory  = [int64][uint64]$d.SharedSystemMemory
            luid          = $luid
            driverVersion = $vc.DriverVersion
            driverDate    = if ($vc.DriverDate) { $vc.DriverDate.ToString('yyyy-MM-dd') } else { $null }
            resolution    = if ($vc.CurrentHorizontalResolution) { "$($vc.CurrentHorizontalResolution) x $($vc.CurrentVerticalResolution)" } else { $null }
            refreshHz     = $vc.CurrentRefreshRate
            processor     = $vc.VideoProcessor
        }
    }
} else {
    foreach ($vc in $videoCtl) {
        $gpus += [ordered]@{
            name = $vc.Name; vram = [int64]$vc.AdapterRAM; luid = $null
            driverVersion = $vc.DriverVersion
            driverDate = if ($vc.DriverDate) { $vc.DriverDate.ToString('yyyy-MM-dd') } else { $null }
            resolution = if ($vc.CurrentHorizontalResolution) { "$($vc.CurrentHorizontalResolution) x $($vc.CurrentVerticalResolution)" } else { $null }
            refreshHz = $vc.CurrentRefreshRate; processor = $vc.VideoProcessor
        }
    }
}

# ---- Storage ----
$partitions = @(Get-Partition | Where-Object DriveLetter)
$volumes = @{}
Get-Volume | Where-Object DriveLetter | ForEach-Object { $volumes["$($_.DriveLetter)"] = $_ }
$diskDrives = @(Get-CimInstance Win32_DiskDrive)

$disks = @(Get-PhysicalDisk | Sort-Object { [int]$_.DeviceId } | ForEach-Object {
    $id = [int]$_.DeviceId
    $dd = $diskDrives | Where-Object { $_.Index -eq $id } | Select-Object -First 1
    $vols = @($partitions | Where-Object { $_.DiskNumber -eq $id } | ForEach-Object {
        $v = $volumes["$($_.DriveLetter)"]
        [ordered]@{
            letter     = "$($_.DriveLetter):"
            label      = $v.FileSystemLabel
            fileSystem = $v.FileSystem
            size       = [int64]$v.Size
            free       = [int64]$v.SizeRemaining
        }
    })
    [ordered]@{
        index     = $id
        model     = $_.FriendlyName
        mediaType = "$($_.MediaType)"
        busType   = "$($_.BusType)"
        size      = [int64]$_.Size
        health    = "$($_.HealthStatus)"
        firmware  = if ($dd) { $dd.FirmwareRevision } else { $_.FirmwareVersion }
        serial    = "$($_.SerialNumber)".Trim()
        volumes   = $vols
    }
})

# ---- Network ----
$ipMap = @{}
Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $ipMap[$_.InterfaceIndex] = $_.IPAddress }
$nics = @(Get-NetAdapter | Where-Object { $_.HardwareInterface -or $_.Status -eq 'Up' } | Sort-Object Status, Name | ForEach-Object {
    [ordered]@{
        name        = $_.Name
        description = $_.InterfaceDescription
        status      = "$($_.Status)"
        linkSpeed   = $_.LinkSpeed
        mac         = $_.MacAddress
        ipv4        = $ipMap[$_.ifIndex]
        physical    = [bool]$_.HardwareInterface
        mediaType   = $_.PhysicalMediaType
    }
})

# ---- Displays ----
$sizes = @{}
Get-CimInstance -Namespace root\wmi WmiMonitorBasicDisplayParams | ForEach-Object {
    if ($_.MaxHorizontalImageSize -gt 0) {
        $inch = [math]::Round([math]::Sqrt([math]::Pow($_.MaxHorizontalImageSize, 2) + [math]::Pow($_.MaxVerticalImageSize, 2)) / 2.54, 1)
        $sizes[$_.InstanceName] = $inch
    }
}
$monitors = @(Get-CimInstance -Namespace root\wmi WmiMonitorID | ForEach-Object {
    [ordered]@{
        name         = Decode-WmiString $_.UserFriendlyName
        manufacturer = Decode-WmiString $_.ManufacturerName
        year         = $_.YearOfManufacture
        sizeInch     = $sizes[$_.InstanceName]
    }
})

# ---- Audio ----
$audio = @(Get-CimInstance Win32_SoundDevice | Where-Object { $_.Status -eq 'OK' } | ForEach-Object {
    [ordered]@{ name = $_.Name; manufacturer = $_.Manufacturer }
})

# ---- Battery ----
$battery = $null
$bat = Get-CimInstance Win32_Battery | Select-Object -First 1
if ($bat) {
    $design = (Get-CimInstance -Namespace root\wmi BatteryStaticData | Select-Object -First 1).DesignedCapacity
    $full   = (Get-CimInstance -Namespace root\wmi BatteryFullChargedCapacity | Select-Object -First 1).FullChargedCapacity
    $battery = [ordered]@{
        name           = $bat.Name
        chemistry      = switch ($bat.Chemistry) { 3 {'Lead Acid'} 4 {'NiCd'} 5 {'NiMH'} 6 {'Li-ion'} 8 {'Li-Polymer'} default { $null } }
        designCapacity = $design
        fullCapacity   = $full
    }
}

$result = [ordered]@{
    collectedAt = (Get-Date).ToString('o')
    system = [ordered]@{
        hostname     = $env:COMPUTERNAME
        manufacturer = $cs.Manufacturer
        model        = $cs.Model
        systemType   = $cs.PCSystemType
        chassis      = $enc.ChassisTypes | Select-Object -First 1
        user         = $env:USERNAME
    }
    os = [ordered]@{
        name        = $os.Caption
        version     = $os.Version
        build       = $os.BuildNumber
        displayVersion = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion
        arch        = $os.OSArchitecture
        installDate = if ($os.InstallDate) { $os.InstallDate.ToString('yyyy-MM-dd') } else { $null }
        lastBoot    = if ($os.LastBootUpTime) { $os.LastBootUpTime.ToString('o') } else { $null }
    }
    board = [ordered]@{
        manufacturer = $board.Manufacturer
        product      = $board.Product
        version      = $board.Version
        biosVendor   = $bios.Manufacturer
        biosVersion  = $bios.SMBIOSBIOSVersion
        biosDate     = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { $null }
        smbios       = "$($bios.SMBIOSMajorVersion).$($bios.SMBIOSMinorVersion)"
    }
    cpu = $cpu
    memory = [ordered]@{
        total    = [int64]$cs.TotalPhysicalMemory
        slots    = $memArray.MemoryDevices
        maxCapacity = if ($memArray.MaxCapacityEx) { [int64]$memArray.MaxCapacityEx * 1024 } else { $null }
        modules  = $memModules
    }
    gpus     = $gpus
    disks    = $disks
    network  = $nics
    monitors = $monitors
    audio    = $audio
    battery  = $battery
}

$result | ConvertTo-Json -Depth 6 -Compress
