@echo off
rem Opens the Disk Cleaner window without leaving a console behind.
rem Right-click > "Run as administrator" to include admin-only categories.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0DiskCleanerGui.ps1"
