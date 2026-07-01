@echo off
rem Launches the Common Ground Test Runner GUI.
rem Double-click this file, or run .\launch-ui.cmd from a terminal.
cd /d "%~dp0"

rem If the UI server is already running, just open the browser.
netstat -ano | findstr ":4317" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo Common Ground Test UI already running - opening browser.
  start "" http://localhost:4317
  exit /b 0
)

echo Starting Common Ground Test UI...
rem Background helper: opens the browser as soon as the server port is up.
start "" /min powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ try{ $c=New-Object Net.Sockets.TcpClient('localhost',4317); $c.Close(); Start-Process 'http://localhost:4317'; break } catch { Start-Sleep -Milliseconds 250 } }"

rem Runs in this window so logs are visible; Ctrl+C stops the server.
node scripts\launch.js scripts\uiServer.js
