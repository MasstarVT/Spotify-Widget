<#
  setup-helper.ps1 - local helper for spotify-setup.html (Windows).

  Started by setup-spotify.bat. Runs a tiny web server on 127.0.0.1:8888 that
  serves spotify-setup.html from this folder, receives Spotify's redirect, and
  writes settings.txt right here, so the setup finishes without copying URLs
  or picking folders.

  It only listens on this computer (127.0.0.1), only serves the setup page,
  and only writes settings.txt. Close the window to stop it.
#>
param(
  [int]$Port = 8888,
  [int]$TimeoutMinutes = 20,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$pagePath = Join-Path $root 'spotify-setup.html'
$settings = Join-Path $root 'settings.txt'
$token    = [guid]::NewGuid().ToString('N')
$utf8     = New-Object System.Text.UTF8Encoding($false)
$ascii    = [System.Text.Encoding]::ASCII

function Fail([string]$message) {
  Write-Host ''
  Write-Host $message
  Write-Host 'You can also open spotify-setup.html directly in Chrome or Edge instead.'
  Read-Host 'Press Enter to close' | Out-Null
  exit 1
}

if (-not (Test-Path $pagePath)) {
  Fail 'spotify-setup.html was not found next to this script. Keep the widget files together in one folder.'
}

try {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  $listener.Start()
} catch {
  Fail "Port $Port is already in use (often by Jupyter or another copy of this setup). Close that program and run this again."
}

Write-Host ''
Write-Host "Spotify widget setup is running at http://127.0.0.1:$Port/"
Write-Host 'Finish the steps in your browser. Leave this window open until the page says it saved settings.txt.'
Write-Host ''
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }

function Send-Http($stream, [int]$status, [string]$reason, [string]$type, [byte[]]$body) {
  $head = "HTTP/1.1 $status $reason`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $headBytes = $ascii.GetBytes($head)
  $stream.Write($headBytes, 0, $headBytes.Length)
  if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

function Send-Text($stream, [int]$status, [string]$reason, [string]$text) {
  Send-Http $stream $status $reason 'text/plain; charset=utf-8' $utf8.GetBytes($text)
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$saved = $false
while ((Get-Date) -lt $deadline) {
  if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 5000
    $buf = New-Object byte[] 65536
    $ms  = New-Object System.IO.MemoryStream
    $headerEnd = -1
    while ($headerEnd -lt 0) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $ms.Write($buf, 0, $n)
      $headerEnd = $ascii.GetString($ms.ToArray()).IndexOf("`r`n`r`n")
    }
    if ($headerEnd -ge 0) {
      $raw     = $ms.ToArray()
      $lines   = $ascii.GetString($raw, 0, $headerEnd) -split "`r`n"
      $request = $lines[0] -split ' '
      $method  = $request[0]
      $path    = ($request[1] -split '\?')[0]
      $headers = @{}
      for ($i = 1; $i -lt $lines.Length; $i++) {
        $colon = $lines[$i].IndexOf(':')
        if ($colon -gt 0) { $headers[$lines[$i].Substring(0, $colon).Trim().ToLower()] = $lines[$i].Substring($colon + 1).Trim() }
      }
      $bodyLen = 0
      if ($headers.ContainsKey('content-length')) { $bodyLen = [int]$headers['content-length'] }
      $bodyMs    = New-Object System.IO.MemoryStream
      $bodyStart = $headerEnd + 4
      if ($raw.Length -gt $bodyStart) { $bodyMs.Write($raw, $bodyStart, $raw.Length - $bodyStart) }
      while ($bodyMs.Length -lt $bodyLen) {
        $n = $stream.Read($buf, 0, [Math]::Min($buf.Length, $bodyLen - $bodyMs.Length))
        if ($n -le 0) { break }
        $bodyMs.Write($buf, 0, $n)
      }
      $body = $bodyMs.ToArray()

      if ($method -eq 'GET' -and ($path -eq '/' -or $path -eq '/callback' -or $path -eq '/spotify-setup.html')) {
        # The setup page, with a marker that tells it a helper is running.
        $html   = [System.IO.File]::ReadAllText($pagePath, $utf8)
        $inject = "<script>window.SETUP_HELPER = { token: '$token', port: $Port };</script>`r`n</head>"
        $html   = $html.Replace('</head>', $inject)
        Send-Http $stream 200 'OK' 'text/html; charset=utf-8' $utf8.GetBytes($html)
      } elseif ($method -eq 'GET' -and $path -eq '/settings') {
        if (Test-Path $settings) { Send-Http $stream 200 'OK' 'text/plain; charset=utf-8' ([System.IO.File]::ReadAllBytes($settings)) }
        else { Send-Text $stream 404 'Not Found' 'no settings.txt yet' }
      } elseif ($method -eq 'POST' -and $path -eq '/save') {
        if ($headers['x-setup-token'] -ne $token) { Send-Text $stream 403 'Forbidden' 'bad token' }
        elseif ($utf8.GetString($body).Trim().Length -eq 0) { Send-Text $stream 400 'Bad Request' 'empty settings' }
        else {
          [System.IO.File]::WriteAllBytes($settings, $body)
          $saved = $true
          Write-Host "settings.txt saved in $root"
          Send-Text $stream 200 'OK' 'saved'
        }
      } else {
        Send-Text $stream 404 'Not Found' 'not found'
      }
    }
  } catch {
    # a dropped connection or malformed request: keep serving
  } finally {
    $client.Close()
  }
}
$listener.Stop()
if ($saved) { Write-Host 'Done. settings.txt is saved. You can close this window.' }
else { Write-Host 'The setup window timed out without saving. Run it again when you are ready.' }
