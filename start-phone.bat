@echo off
title Artee - Phone Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this PC.
  echo   Install it once from https://nodejs.org  ^(LTS version^), then
  echo   double-click this file again.
  echo.
  pause
  exit /b 1
)

rem  One-time: let the phone reach this PC through the Windows Firewall.
net session >nul 2>nul
if errorlevel 1 (
  echo   Asking Windows for permission to open the firewall for Artee...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0enable-phone-access.ps1'"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-phone-access.ps1"
)

echo.
echo   Starting Artee for your phone...
echo   The phone just scans a QR code - it needs internet
echo   (Wi-Fi or mobile data). First launch takes ~10 seconds.
node "phone-server.js"

echo.
echo   Server stopped.
pause
