@echo off
rem Builds release\HWMonitor.exe (single file; needs the .NET 10 Desktop Runtime on the target PC).
rem Pass "standalone" to bundle the runtime instead (larger exe, runs on any Windows 10/11 x64).
rem Intermediate files go to %TEMP% to stay clear of the 260-char path limit.
setlocal
set SC=false
if /i "%~1"=="standalone" set SC=true
dotnet publish "%~dp0HWMonitor.csproj" -c Release --self-contained %SC% -p:EnableCompressionInSingleFile=%SC% --artifacts-path "%TEMP%\hwmonitor-build" -o "%~dp0..\release" --nologo
