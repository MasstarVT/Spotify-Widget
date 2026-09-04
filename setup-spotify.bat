@echo off
title Spotify widget setup
rem Runs the local setup helper (see setup-helper.ps1). Nothing to install:
rem PowerShell is part of Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-helper.ps1"
pause
