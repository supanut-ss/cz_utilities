@echo off
rem Builds release\HWMonitor.exe (single file; needs the .NET 10 Desktop Runtime on the target PC).
rem "publish.cmd standalone" bundles the runtime instead: release\standalone\HWMonitor.exe, larger,
rem runs on any Windows 10/11 x64 PC. Install either build with:  HWMonitor.exe --install
rem Intermediate files go to %TEMP% to stay clear of the 260-char path limit.
setlocal
set SC=false
set OUT=%~dp0..\release
if /i "%~1"=="standalone" (
  set SC=true
  set OUT=%~dp0..\release\standalone
)
dotnet publish "%~dp0HWMonitor.csproj" -c Release --self-contained %SC% -p:EnableCompressionInSingleFile=%SC% --artifacts-path "%TEMP%\hwmonitor-build-%SC%" -o "%OUT%" --nologo
