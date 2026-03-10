@echo off
chcp 65001 >nul
title StoryWeaver AI - Launcher

echo ========================================
echo   StoryWeaver AI - Novel Visualization Platform
echo ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not detected, please install Node.js first
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

:: Display Node.js version
echo [INFO] Node.js version:
node -v
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] First run, installing dependencies...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency installation failed
        pause
        exit /b 1
    )
    echo.
    echo [SUCCESS] Dependencies installed
    echo.
)

:: Check .env.local file
if not exist ".env.local" (
    echo [WARNING] .env.local file not found
    echo [INFO] Please create .env.local file and configure GEMINI_API_KEY
    echo.
    echo Example content:
    echo GEMINI_API_KEY=your_api_key_here
    echo.
    pause
)

:: Get local network IP address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "ip=%%a"
    goto :found_ip
)
:found_ip
set "ip=%ip: =%"

:: Start development server
echo [STARTING] Starting development server...
echo.
echo [Local Access] http://localhost:3000
if defined ip (
    echo [Network Access] http://%ip%:3000
    echo.
    echo [INFO] Other devices on the network can access via the network address above
)
echo.
echo ----------------------------------------
echo Press Ctrl+C to stop the server
echo ----------------------------------------
echo.

npm start

pause
