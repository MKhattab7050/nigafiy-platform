@echo off
rem Double-click to run Nigafiy on this computer. Close this window (or press Ctrl+C) to stop it.
title Nigafiy
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required: https://nodejs.org
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo Installing pnpm...
  call npm install -g pnpm@10
)
call pnpm local
pause
