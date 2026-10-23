@echo off
rem Builds the LibreHardwareMonitor sensor helper into sensors\dist (needs the .NET 10 SDK).
rem Intermediate files go to %TEMP% to stay clear of the 260-char path limit.
dotnet publish "%~dp0HwSensors.csproj" -c Release --artifacts-path "%TEMP%\hwsensors-build" -o "%~dp0dist" --nologo
