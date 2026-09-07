<#
  setup-helper.ps1 - local helper for the Spotify widget (Windows).

  Lives in tools\ next to spotify-setup.html; the widget folder is the parent.

  Started by setup-spotify.bat: runs a tiny web server on 127.0.0.1:8888 that
  serves spotify-setup.html, receives Spotify's redirect, and writes
  settings.txt into the widget folder, so the setup finishes without copying
  URLs or picking folders. It only listens on this computer (127.0.0.1), only
  serves the setup page, and only writes settings.txt. Close the window to
  stop it.

  Started by update-widget.bat (-Update): downloads the newest release and
  replaces the files in the widget folder. settings.txt is never touched, the
  value blocks at the top of the widget file (:root and each look's block)
  keep your values, files from before the looks were merged into one page
  (zune-now-playing.html, ...) are refreshed in place so OBS can keep
  pointing at them, and every file that is replaced is copied to
  backup\<version>\ first.
#>
param(
  [int]$Port = 8888,
  [int]$TimeoutMinutes = 20,
  [switch]$NoBrowser,
  [switch]$Update,
  [string]$Source = ''     # with -Update: install this zip (path or URL) instead of the newest release
)

$ErrorActionPreference = 'Stop'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path   # tools\
$root     = Split-Path -Parent $here                          # the widget folder
if (-not (Test-Path (Join-Path $root 'now-playing-source.js')) -and (Test-Path (Join-Path $here 'now-playing-source.js'))) {
  $root = $here                                               # a copy placed next to the widgets (the layout before tools\)
}
$pagePath = Join-Path $here 'spotify-setup.html'
$settings = Join-Path $root 'settings.txt'
$sourceJs = Join-Path $root 'now-playing-source.js'   # ($Source, the parameter, is a different thing)
$updateUrlDefault = 'https://masstarvt.github.io/Spotify-Widget/'       # where releases are published
$keep     = @('settings.txt')                                            # never replaced by an update
$stale    = @('setup-helper.py', 'setup-helper.ps1', 'spotify-setup.html')   # top-level copies from before tools\
$token    = [guid]::NewGuid().ToString('N')
$utf8     = New-Object System.Text.UTF8Encoding($false)
$ascii    = [System.Text.Encoding]::ASCII

function Fail([string]$message) {
  Write-Host ''
  Write-Host $message
  if (-not $Update) {
    Write-Host 'You can also open tools\spotify-setup.html directly in Chrome or Edge instead.'
    Read-Host 'Press Enter to close' | Out-Null
  }
  exit 1
}

if (-not (Test-Path $pagePath)) {
  Fail 'spotify-setup.html was not found next to this script. Keep the unzipped folder as it is (tools\ next to the widget files).'
}

# ── versions ────────────────────────────────────────────────────────────────

function Get-UpdateUrl {
  # update_url from settings.txt (same rule as the widget), else the default.
  $url = $updateUrlDefault
  if (Test-Path $settings) {
    foreach ($line in [System.IO.File]::ReadAllLines($settings, $utf8)) {
      $line = $line.Trim()
      if ($line -eq '' -or $line.StartsWith('#') -or $line.IndexOf('=') -lt 0) { continue }
      $eq = $line.IndexOf('=')
      if ($line.Substring(0, $eq).Trim().ToLower() -ne 'update_url') { continue }
      $val = ($line.Substring($eq + 1) -replace '\s#.*$', '').Trim()
      if ($val -match '^https?://') { $url = $val }
    }
  }
  if (-not $url.EndsWith('/')) { $url += '/' }
  return $url
}

function Get-StampOf([string]$js) {
  # WIDGET_VERSION as written in a copy of now-playing-source.js ('' if none).
  $m = [regex]::Match($js, "WIDGET_VERSION\s*=\s*'([^']*)'")
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

function Get-LocalStamp {
  if (-not (Test-Path $sourceJs)) { return '' }
  return Get-StampOf ([System.IO.File]::ReadAllText($sourceJs, $utf8))
}

function Get-LocalVersion {
  # The release version of the files here ('' for a working copy or unknown).
  $v = Get-LocalStamp
  if ($v.StartsWith('$Format')) { return '' }
  return $v
}

function Get-VersionNumber([string]$s) {
  $m = [regex]::Match(([string]$s).Trim(), '^[vV](\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return $null
}

# ── update ──────────────────────────────────────────────────────────────────

function Merge-Block([string]$old, [string]$new, [string]$oldSelector, [string]$newSelector) {
  # Carry the values of one block (":root", or a look's [data-theme="..."]
  # block at the top of the widget file) of the old file into a block of the
  # new file: same names take the old value, names the new file does not
  # know are added.
  $mo = [regex]::Match($old, [regex]::Escape($oldSelector) + '\s*\{[^}]*\}')
  $mn = [regex]::Match($new, [regex]::Escape($newSelector) + '\s*\{[^}]*\}')
  if (-not $mo.Success -or -not $mn.Success) { return $new }
  $eol = if ($new.Contains("`r`n")) { "`r`n" } else { "`n" }
  $block = $mn.Value
  foreach ($d in [regex]::Matches($mo.Value, '(--[\w-]+)\s*:\s*([^;]*);')) {
    $name = $d.Groups[1].Value; $val = $d.Groups[2].Value.Trim()
    $one = [regex]('(' + [regex]::Escape($name) + ')(\s*:\s*)([^;]*);')
    $m = $one.Match($block)
    if ($m.Success) {
      if ($m.Groups[3].Value.Trim() -ne $val) {     # keep the line's own spacing, only swap the value
        $block = $block.Substring(0, $m.Index) + $m.Groups[1].Value + $m.Groups[2].Value + $val + ';' + $block.Substring($m.Index + $m.Length)
      }
    } else {
      $block = $block.Substring(0, $block.Length - 1).TrimEnd() + $eol + '    ' + $name + ': ' + $val + ';' + $eol + '  }'
    }
  }
  return $new.Substring(0, $mn.Index) + $block + $new.Substring($mn.Index + $mn.Length)
}

function Get-Looks([string]$widget) {
  # The looks a widget-now-playing.html has (its <template data-theme="..."> tags).
  return @([regex]::Matches($widget, '<template data-theme="([a-z0-9-]+)"') | ForEach-Object { $_.Groups[1].Value })
}

function Merge-Widget([string]$old, [string]$new, [string]$name) {
  # Carry the values of a widget file across an update: its :root block and,
  # in widget-now-playing.html, each look's block. A file from before the
  # looks were merged (zune-now-playing.html, ...) holds one look's values in
  # its :root: those become that look's values in the new file.
  $looks = Get-Looks $new
  if ($old -notmatch '\[data-theme=') {
    $stem = $name -replace '-now-playing\.html$', ''
    if ($looks -contains $stem) { return Merge-Block $old $new ':root' ('[data-theme="' + $stem + '"]') }
    return Merge-Block $old $new ':root' ':root'
  }
  $out = Merge-Block $old $new ':root' ':root'
  foreach ($t in $looks) {
    $sel = '[data-theme="' + $t + '"]'
    $out = Merge-Block $old $out $sel $sel
  }
  return $out
}

function Invoke-Update {
  # Install the newest release (or the zip given as -Source, a path or URL).
  if ((Get-LocalStamp).StartsWith('$Format')) {
    Write-Host 'This folder is a git working copy (no release version stamped in): update it with git pull.'
    return 1
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'    # the progress bar makes downloads very slow in PowerShell 5
  $base  = Get-UpdateUrl
  $local = Get-LocalVersion
  if ($local) { Write-Host "Widget files here: $local" } else { Write-Host 'Widget files here: unknown version' }
  $tmp = [System.IO.Path]::GetTempFileName()
  if ($Source) {
    Write-Host "Reading $Source ..."
    try {
      if ($Source -match '^https?://') { Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $tmp }
      else { Copy-Item -LiteralPath $Source -Destination $tmp -Force }
    } catch {
      Write-Host "Could not read it ($($_.Exception.Message)). Nothing changed."
      return 1
    }
  } else {
    Write-Host "Checking $base ..."
    try {
      $stamp  = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      $latest = ((Invoke-WebRequest -UseBasicParsing -Uri ($base + "version.json?_=$stamp")).Content | ConvertFrom-Json).version
    } catch {
      Write-Host "Could not read the latest version ($($_.Exception.Message)). Check the connection and try again."
      return 1
    }
    $ln = Get-VersionNumber $local
    $rn = Get-VersionNumber $latest
    if ($null -eq $rn) { Write-Host "Unexpected version `"$latest`" from $base. Nothing changed."; return 1 }
    if ($null -ne $ln -and $ln -ge $rn) { Write-Host "Already current: the latest release is $latest."; return 0 }
    Write-Host "Downloading $latest ..."
    try {
      Invoke-WebRequest -UseBasicParsing -Uri ($base + 'Widget.zip') -OutFile $tmp
    } catch {
      Write-Host "Download failed ($($_.Exception.Message)). Nothing changed."
      return 1
    }
  }
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
  } catch {
    Write-Host 'That is not a zip file. Nothing changed.'
    return 1
  }
  try {
    $names = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName })
    $remote = ''
    if ($names -contains 'now-playing-source.js') {
      $e = $zip.GetEntry('now-playing-source.js')
      $sr = New-Object System.IO.StreamReader($e.Open(), $utf8)
      $remote = Get-StampOf $sr.ReadToEnd()
      $sr.Close()
    }
    if ($null -eq (Get-VersionNumber $remote)) {   # the zip's own stamp is what counts, not version.json
      Write-Host 'That is not a release of the widget (no version stamped into now-playing-source.js). Nothing changed.'
      return 1
    }
    $ln = Get-VersionNumber $local
    if ($null -ne $ln -and $ln -ge (Get-VersionNumber $remote)) { Write-Host "Already current: that is $remote."; return 0 }
    $backupName = if ($local) { $local } else { Get-Date -Format 'yyyyMMdd-HHmmss' }
    $backup = Join-Path (Join-Path $root 'backup') $backupName
    $replaced = 0; $kept = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if ($name.EndsWith('/')) { continue }
      $parts = $name -split '/'
      if ($keep -contains $name -or $parts -contains '..' -or $parts -contains '') { continue }
      $dest = $root
      foreach ($p in $parts) { $dest = Join-Path $dest $p }
      $ms = New-Object System.IO.MemoryStream
      $s = $entry.Open(); $s.CopyTo($ms); $s.Close()
      $data = $ms.ToArray()
      if (Test-Path $dest) {
        $old = [System.IO.File]::ReadAllBytes($dest)
        if ($old.Length -eq $data.Length -and [System.Linq.Enumerable]::SequenceEqual([byte[]]$old, [byte[]]$data)) { continue }
        $bdir = $backup
        for ($i = 0; $i -lt $parts.Length - 1; $i++) { $bdir = Join-Path $bdir $parts[$i] }
        New-Item -ItemType Directory -Force $bdir | Out-Null
        Copy-Item $dest (Join-Path $bdir $parts[-1]) -Force
        if ($name.EndsWith('-now-playing.html')) {
          $newText = $utf8.GetString($data)
          $merged  = Merge-Widget $utf8.GetString($old) $newText $name
          if ($merged -ne $newText) { $kept++ }
          $data = $utf8.GetBytes($merged)
        }
      }
      New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
      [System.IO.File]::WriteAllBytes($dest, $data)
      $replaced++
    }
    # Files from before the looks were merged into widget-now-playing.html
    # (zune-now-playing.html, ...) that OBS may still point at: refresh each
    # one into a copy of the merged page that shows that look, keeping its
    # values, rather than leaving an old page next to the new script.
    $refreshed = 0
    if ($names -contains 'widget-now-playing.html') {
      $e  = $zip.GetEntry('widget-now-playing.html')
      $sr = New-Object System.IO.StreamReader($e.Open(), $utf8)
      $widgetText = $sr.ReadToEnd()
      $sr.Close()
      foreach ($t in (Get-Looks $widgetText)) {
        $legacy = "$t-now-playing.html"
        $dest   = Join-Path $root $legacy
        if ($names -contains $legacy -or -not (Test-Path $dest)) { continue }
        $oldText = [System.IO.File]::ReadAllText($dest, $utf8)
        $merged  = Merge-Widget $oldText $widgetText $legacy
        if ($merged -eq $oldText) { continue }
        New-Item -ItemType Directory -Force $backup | Out-Null
        Copy-Item $dest (Join-Path $backup $legacy) -Force
        [System.IO.File]::WriteAllText($dest, $merged, $utf8)
        $refreshed++
      }
    }
    # Releases before the tools\ folder kept these at the top level: tidy them
    # into the backup rather than leaving two copies around.
    $tidied = 0
    if ($root -ne $here) {
      foreach ($name in $stale) {
        $old = Join-Path $root $name
        if ($names -notcontains $name -and (Test-Path $old)) {
          New-Item -ItemType Directory -Force $backup | Out-Null
          Move-Item $old (Join-Path $backup $name) -Force
          $tidied++
        }
      }
    }
  } finally {
    $zip.Dispose()
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  $from = if ($local) { $local } else { 'unknown' }
  $note = if ($kept) { ", your colour settings kept in $kept widget file(s)" } else { '' }
  Write-Host "Updated $from -> ${remote}: $replaced file(s) replaced$note."
  if ($refreshed) { Write-Host "Refreshed $refreshed widget file(s) from before the looks were merged: OBS can keep pointing at them, but widget-now-playing.html is the one to use now." }
  if ($tidied) { Write-Host "Moved $tidied old file(s) from before the tools folder into the backup." }
  if ($replaced -or $refreshed -or $tidied) { Write-Host "The previous files are in $backup" }
  Write-Host 'settings.txt was not touched. OBS shows the new version when the widget next loads.'
  return 0
}

if ($Update -or $Source) { exit (Invoke-Update) }

# ── setup server ────────────────────────────────────────────────────────────

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

      # Only requests addressed to this computer by its own name are served.
      # A web page could otherwise point a name of its own at 127.0.0.1 (DNS
      # rebinding) and read or write settings.txt through this server as if
      # it were the setup page.
      $hostName = ''
      if ($headers.ContainsKey('host')) { $hostName = ($headers['host'] -replace ':\d+$', '').Trim().ToLower() }
      $localHost = ($hostName -eq '127.0.0.1' -or $hostName -eq 'localhost')

      if (-not $localHost) {
        Send-Text $stream 403 'Forbidden' 'wrong host'
      } elseif ($method -eq 'GET' -and ($path -eq '/' -or $path -eq '/callback' -or $path -eq '/spotify-setup.html')) {
        # The setup page, with a marker that tells it a helper is running.
        $html    = [System.IO.File]::ReadAllText($pagePath, $utf8)
        $marker  = @{ token = $token; port = $Port; version = [string](Get-LocalVersion); updateUrl = [string](Get-UpdateUrl) } | ConvertTo-Json -Compress
        $marker  = $marker.Replace('</', '<\/')       # nothing in it may end the script element
        $inject  = "<script>window.SETUP_HELPER = $marker;</script>`r`n</head>"
        $html    = $html.Replace('</head>', $inject)
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
