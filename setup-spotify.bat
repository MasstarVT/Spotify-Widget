@echo off
title Spotify widget setup
rem Runs the local setup helper (tools\setup-helper.ps1). Nothing to install:
rem PowerShell is part of Windows. Everything happens on the last line, so
rem an update can replace this file while it runs.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup-helper.ps1" & pause & exit
