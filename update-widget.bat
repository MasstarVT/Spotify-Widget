@echo off
title Spotify widget update
rem Downloads the newest release into this folder (tools\setup-helper.ps1).
rem settings.txt and your colour settings are kept; replaced files go to
rem backup\ first. Everything happens on the last line, so the update can
rem replace this file while it runs.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup-helper.ps1" -Update & pause & exit
