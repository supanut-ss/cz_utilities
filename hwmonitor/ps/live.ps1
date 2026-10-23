# Streams live performance counters as one JSON line per interval.
# Uses Win32_PerfFormattedData_* classes because they are not localized (unlike Get-Counter paths).
# -ParentPid: exit when the host process is gone, so a crashed host never leaves this loop running.
param([int]$IntervalMs = 1000, [int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($true) {
    $started = [DateTime]::UtcNow
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

    $cores = @(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor |
        Where-Object Name -ne '_Total' | Sort-Object { [int]$_.Name } |
        ForEach-Object { [int]$_.PercentProcessorTime })
    $cpuTotal = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime

    # Effective clock = base clock * % performance (can exceed 100% with turbo)
    $procInfo = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"

    $os  = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory, TotalVisibleMemorySize
    $sys = Get-CimInstance Win32_PerfFormattedData_PerfOS_System -Property Processes, Threads, SystemUpTime
    $mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property CommittedBytes, CommitLimit, CacheBytes

    $disks = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object Name -ne '_Total' | ForEach-Object {
        [ordered]@{
            index  = [int]($_.Name -split ' ')[0]
            active = [math]::Max(0, 100 - [int]$_.PercentIdleTime)
            read   = [int64]$_.DiskReadBytesPersec
            write  = [int64]$_.DiskWriteBytesPersec
        }
    })

    $net = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | ForEach-Object {
        [ordered]@{ name = $_.Name; rx = [int64]$_.BytesReceivedPersec; tx = [int64]$_.BytesSentPersec }
    })

    # Sum engine utilization per adapter+engine type, then report the busiest engine type per adapter
    $engines = @{}
    foreach ($e in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name, UtilizationPercentage)) {
        if ($e.Name -match '(luid_0x[0-9A-F]+_0x[0-9A-F]+).*engtype_(.+)$') {
            $key = "$($Matches[1])|$($Matches[2])"
            $engines[$key] = [int]$engines[$key] + [int]$e.UtilizationPercentage
        }
    }
    $gpu = @{}
    foreach ($k in $engines.Keys) {
        $luid, $type = $k -split '\|'
        if (-not $gpu[$luid]) { $gpu[$luid] = [ordered]@{ luid = $luid; util = 0; engines = [ordered]@{}; dedicated = 0; shared = 0 } }
        $v = [math]::Min(100, $engines[$k])
        $gpu[$luid].engines[$type] = $v
        if ($v -gt $gpu[$luid].util) { $gpu[$luid].util = $v }
    }
    foreach ($m in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory)) {
        if ($m.Name -match '(luid_0x[0-9A-F]+_0x[0-9A-F]+)') {
            $luid = $Matches[1]
            if (-not $gpu[$luid]) { $gpu[$luid] = [ordered]@{ luid = $luid; util = 0; engines = [ordered]@{}; dedicated = 0; shared = 0 } }
            $gpu[$luid].dedicated += [int64]$m.DedicatedUsage
            $gpu[$luid].shared    += [int64]$m.SharedUsage
        }
    }

    # ACPI thermal zones: tenths of Kelvin, readable without admin rights
    $thermal = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object {
        $t = if ($_.HighPrecisionTemperature) { $_.HighPrecisionTemperature / 10 } else { $_.Temperature }
        if ($t -gt 0) { [ordered]@{ name = ($_.Name -replace '^\\_TZ\.', ''); celsius = [math]::Round($t - 273.15, 1) } }
    })

    $sample = [ordered]@{
        t        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        cpu      = [ordered]@{
            total     = [int]$cpuTotal
            cores     = $cores
            perfPct   = [int]$procInfo.PercentProcessorPerformance
            freqMHz   = [int]$procInfo.ProcessorFrequency
        }
        memory   = [ordered]@{
            total     = [int64]$os.TotalVisibleMemorySize * 1024
            free      = [int64]$os.FreePhysicalMemory * 1024
            committed = [int64]$mem.CommittedBytes
            commitLimit = [int64]$mem.CommitLimit
            cache     = [int64]$mem.CacheBytes
        }
        system   = [ordered]@{ processes = [int]$sys.Processes; threads = [int]$sys.Threads; uptime = [int64]$sys.SystemUpTime }
        disks    = $disks
        net      = $net
        gpus     = @($gpu.Values)
        thermal  = $thermal
    }
    [Console]::Out.WriteLine(($sample | ConvertTo-Json -Depth 5 -Compress))
    [Console]::Out.Flush()

    $elapsed = ([DateTime]::UtcNow - $started).TotalMilliseconds
    $wait = [int]($IntervalMs - $elapsed)
    if ($wait -gt 50) { Start-Sleep -Milliseconds $wait }
}
