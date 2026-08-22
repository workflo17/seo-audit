@echo off
rem SEO audit tool launcher (:4950).
rem Safe to double-click any time: if the server is already up it just opens the page.
title SEO Audit
cd /d "%~dp0"

netstat -ano | findstr ":4950" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo Already running - opening http://localhost:4950
    start "" http://localhost:4950
    exit /b 0
)

echo Starting the SEO audit tool on http://localhost:4950 ...
echo Paste a website, fill the optional fields, hit Run. Takes about two minutes.
echo Reports land in %~dp0out\
echo.
echo Leave this window open while you work. Close it to stop the server.
start "" /min cmd /c "%SystemRoot%\System32\timeout.exe /t 3 >nul & start "" http://localhost:4950"
node server.mjs

echo.
echo Server stopped. Press a key to close.
pause >nul
