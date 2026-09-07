@echo off
title Spotify widget update
rem Downloads the newest release into this folder. settings.txt and your colour
rem settings are kept; replaced files go to backup\ first (see setup-helper.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-helper.ps1" -Update
pause
