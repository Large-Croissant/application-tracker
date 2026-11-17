@echo off
rem Launches the JobTracker dev session (Tauri dev window with hot reload).
rem Double-click this file, or run it from any terminal.
rem Close the app window to end the session; the console stays open afterwards
rem so you can read any build output or errors.

title JobTracker dev
cd /d "%~dp0"
call dev_env.cmd npm run tauri dev
echo.
echo Dev session ended.
pause
