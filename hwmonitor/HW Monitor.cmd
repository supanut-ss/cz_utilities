@echo off
rem Launches HW Monitor in its own window; the background server exits when the window is closed.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"
