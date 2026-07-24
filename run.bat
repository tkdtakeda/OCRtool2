@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  OCR Tool - Server Launcher
echo ============================================
echo.

if exist proxy.txt (
    set /p PROXYURL=<proxy.txt
    if not "!PROXYURL!"=="" (
        set HTTP_PROXY=!PROXYURL!
        set HTTPS_PROXY=!PROXYURL!
        echo Using proxy settings from proxy.txt
        echo.
    )
)

echo [1/4] Checking for Python...
set PYCMD=
for /f "delims=" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo %PYVER% | findstr /b /c:"Python " >nul
if not errorlevel 1 (
    set PYCMD=python
    goto :havepython
)

for /f "delims=" %%v in ('py --version 2^>^&1') do set PYVER=%%v
echo %PYVER% | findstr /b /c:"Python " >nul
if not errorlevel 1 (
    set PYCMD=py
    goto :havepython
)

echo.
echo [ERROR] Python was not found.
echo   If typing "python" opens the Microsoft Store, Python is not really
echo   installed - turn off the "python" App Execution Alias first:
echo   Settings, Apps, Advanced app settings, App execution aliases.
echo   Then install Python from https://www.python.org/downloads/
echo   IMPORTANT: check "Add python.exe to PATH" during setup.
echo   After installing, close this window and double-click run.bat again.
goto :end

:havepython
echo   Using: %PYCMD%  ^( %PYVER% ^)
echo.

echo [2/4] Checking required packages...
%PYCMD% -c "import flask, cv2, PIL, pytesseract" >nul 2>nul
if not errorlevel 1 (
    echo   Already installed - skipping download.
    goto :startserver
)

echo [3/4] Installing required packages, please wait...
echo       (first run may take a few minutes to download)
echo.
%PYCMD% -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install required packages.
    echo Please check the messages above ^(lines starting with ERROR^).
    echo.
    echo If you saw "Proxy" / "407" / "authentication required" above,
    echo this network needs a proxy with credentials. Create a file named
    echo proxy.txt in this same folder containing one line like:
    echo   http://username:password@proxyserver:port
    echo Ask your IT department for the exact address if you do not know it.
    echo Then run run.bat again. See README.md for more details.
    goto :end
)

:startserver
echo.
echo [4/4] Starting the server.
echo       Press Ctrl+C in this window to stop it.
echo.
%PYCMD% run_server.py
echo.
echo Server stopped.

:end
echo.
echo ============================================
echo Press any key to close this window.
echo If there was an error above, please note it down first.
echo ============================================
pause >nul
