@echo off
chcp 65001 >nul
set "EXT=%~dp0"
set "BROWSER="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if "%BROWSER%"=="" if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if "%BROWSER%"=="" if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if "%BROWSER%"=="" (
  echo 没找到 Chrome/Edge，请自己装一个 Chrome。
  pause
  exit /b
)
echo ============================================================
echo  请先【完全退出】浏览器（所有窗口+托盘图标），再按任意键继续
echo  扩展目录: %EXT%
echo ============================================================
pause
start "" "%BROWSER%" --load-extension="%EXT:~0,-1%" --profile-directory="Default"
exit
