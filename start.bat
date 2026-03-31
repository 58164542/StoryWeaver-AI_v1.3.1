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

:: Check if Seedance service dependencies are installed
if not exist "server\seedance\node_modules\" (
    echo [INFO] Installing Seedance service dependencies...
    cd server\seedance
    call npm install
    if errorlevel 1 (
        echo [ERROR] Seedance dependencies installation failed
        cd ..\..
        pause
        exit /b 1
    )
    echo [INFO] Installing Chromium for browser service...
    call npx playwright-core install chromium
    cd ..\..
    echo.
)

:: Start development servers
echo [STARTING] Starting services...
echo.

:: Kill any process using port 3005
echo [INFO] Checking port 3005...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3005 ^| findstr LISTENING') do (
    if not "%%a"=="0" (
        echo [INFO] Killing process %%a on port 3005...
        taskkill /PID %%a /F >nul 2>&1
    )
)
timeout /t 2 /nobreak >nul

echo [Local Access] http://localhost:3000
if defined ip (
    echo [Network Access] http://%ip%:3000
    echo [Seedance Service] http://%ip%:3005
    echo.
    echo [INFO] Other devices on the network can access via the network address above
)
echo.
echo ----------------------------------------
echo Press Ctrl+C to stop all servers
echo ----------------------------------------
echo.

:: Start both services in one window
npx concurrently -n "Main,Vite,Seedance" -c "cyan,green,yellow" "npm run server" "npm run dev" "npm run seedance"

pause
