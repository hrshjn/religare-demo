@echo off
REM Double-click to run the demo on Windows. Needs Node.js 18+ (https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again. & pause & exit /b 1)
if not exist node_modules call npm install --no-audit --no-fund
start "" "http://localhost:8787"
call npm start
pause
