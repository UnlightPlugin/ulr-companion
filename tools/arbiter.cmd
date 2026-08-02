@echo off
rem ---------------------------------------------------------------------------
rem  Double-click entry point for the move-phase arbiter.
rem
rem  Why this file exists: .ps1 does not run on double-click (Windows opens it
rem  in an editor), and a PowerShell window opened by the shell closes the
rem  instant the script ends -- taking every error message with it.
rem
rem  ASCII only on purpose. A .cmd file with Chinese text gets mangled by
rem  whatever codepage the console happens to be in (CP950 on this machine).
rem  The PowerShell script it calls is UTF-8 with BOM and prints Chinese fine.
rem ---------------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0arbiter.ps1" %*
echo.
pause
