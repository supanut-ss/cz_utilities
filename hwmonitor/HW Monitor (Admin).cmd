@echo off
rem Same as "HW Monitor.cmd" but runs the server elevated, which CPU and motherboard sensors need.
rem Close any running HW Monitor window first, otherwise the non-elevated server is reused.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1" -Admin
