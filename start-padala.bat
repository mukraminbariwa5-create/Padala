@echo off
title Padala server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get version 22.13 or newer from https://nodejs.org then run this again.
  pause
  exit /b 1
)
echo Starting Padala... keep this window open while you use the app.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080"
node --disable-warning=ExperimentalWarning server/index.js
echo.
echo Padala stopped.
pause
