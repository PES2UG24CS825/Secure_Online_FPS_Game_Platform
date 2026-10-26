@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "LAN_IP="
set "LAN_MODE=1"
set "FLASK_DEBUG=0"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$adapter = ''; $items = foreach ($line in (ipconfig)) { if ($line -match 'adapter (.+):$') { $adapter = $Matches[1] }; if ($line -match 'IPv4' -and $line -match '((?:\d{1,3}\.){3}\d{1,3})\s*$') { $ip = $Matches[1]; if ($ip -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and $adapter -notmatch 'Npcap|VirtualBox|VMware|Hyper-V|vEthernet|Docker|WSL|TAP|TUN|Loopback') { [pscustomobject]@{ IPAddress = $ip; Alias = $adapter } } } }; $items ^| Sort-Object @{Expression = { if ($_.Alias -match 'Local Area Connection') { 0 } elseif ($_.Alias -match 'Wi-Fi|Wireless') { 1 } elseif ($_.Alias -match 'Ethernet') { 2 } else { 3 } }} ^| Select-Object -First 1 -ExpandProperty IPAddress"`) do set "LAN_IP=%%I"

if not defined LAN_IP (
  echo Could not detect a private IPv4 address. Connect to Wi-Fi or enable Mobile hotspot and try again.
  pause
  exit /b 1
)

if exist "%PROJECT_ROOT%backend\.venv\Scripts\activate.bat" (
  start "SecureFPS backend" /D "%PROJECT_ROOT%backend" cmd /k "call .venv\Scripts\activate.bat ^&^& python app.py"
) else (
  start "SecureFPS backend" /D "%PROJECT_ROOT%backend" cmd /k "python app.py"
)

timeout /t 2 /nobreak >nul
echo.
echo SecureFPS is starting.
echo Open from another laptop: http://%LAN_IP%:5000/login.html
echo Open on this laptop:      http://127.0.0.1:5000/login.html
echo Keep the SecureFPS backend window open.
pause
