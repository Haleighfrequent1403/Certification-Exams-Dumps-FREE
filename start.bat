@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Certification Exam Questions
cd /d "%~dp0"

set "SETUP_LOG=%TEMP%\free-exam-dumps-setup.log"

call :find_node
if not defined NODE_EXE (
  if defined EXAM_PDF_SKIP_INSTALL goto :manual_setup
  where winget.exe >nul 2>nul || goto :manual_setup
  echo   Preparing the first run...
  winget install --id OpenJS.NodeJS.LTS --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements >"%SETUP_LOG%" 2>&1
  if errorlevel 1 goto :setup_failed
  set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs;%PATH%"
  call :find_node
  if not defined NODE_EXE goto :setup_failed
)

call :find_browser
if not defined BROWSER_EXE (
  if defined EXAM_PDF_SKIP_INSTALL goto :manual_setup
  where winget.exe >nul 2>nul || goto :manual_setup
  echo   Preparing the PDF maker...
  winget install --id Microsoft.Edge --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements >"%SETUP_LOG%" 2>&1
  if errorlevel 1 goto :setup_failed
  call :find_browser
  if not defined BROWSER_EXE goto :setup_failed
)

:run
set "EXAM_BROWSER_PATH=%BROWSER_EXE%"
"%NODE_EXE%" app.mjs %*
set "APP_EXIT=%ERRORLEVEL%"
echo.
if not defined EXAM_PDF_NO_PAUSE pause
exit /b %APP_EXIT%

:find_node
set "NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE call :accept_node "%%N"
if not defined NODE_EXE call :accept_node "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE call :accept_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"
exit /b

:accept_node
if not exist "%~1" exit /b
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if not errorlevel 1 set "NODE_EXE=%~1"
exit /b

:find_browser
set "BROWSER_EXE="
if defined EXAM_BROWSER_PATH if exist "%EXAM_BROWSER_PATH%" set "BROWSER_EXE=%EXAM_BROWSER_PATH%"
if not defined BROWSER_EXE if defined BROWSER_PATH if exist "%BROWSER_PATH%" set "BROWSER_EXE=%BROWSER_PATH%"
for %%B in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do if not defined BROWSER_EXE if exist "%%~fB" set "BROWSER_EXE=%%~fB"
exit /b

:manual_setup
echo.
echo   Automatic setup is unavailable. Install Node.js 20 or newer and Microsoft Edge, then run this file again.
echo.
if not defined EXAM_PDF_NO_PAUSE pause
exit /b 1

:setup_failed
echo.
echo   Setup could not finish. Install Node.js 20 or newer and Microsoft Edge, then run this file again.
echo   Details: %SETUP_LOG%
echo.
if not defined EXAM_PDF_NO_PAUSE pause
exit /b 1
