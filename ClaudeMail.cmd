@echo off
REM Thin launcher: ~/.local/bin stays free of program files and node_modules.
REM The program itself lives in ~/.local/ClaudeMail (with its own package.json).
node "%~dp0..\ClaudeMail\ClaudeMail.js" %*
exit /b %ERRORLEVEL%
