@echo off
rem The authdeck command on Windows. The user PATH names this folder; it starts AuthDeck Agent
rem in its CLI mode, which runs only the command bundled with it, so the computer needs no
rem Node.js. After -- Chromium reads no switches: the arguments are the command's alone.
"%~dp0..\..\AuthDeck Agent.exe" --authdeck-cli -- %*
exit /b %ERRORLEVEL%
