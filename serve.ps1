param(
  [int]$Port = 8080,
  [string]$Root = (Join-Path $PSScriptRoot 'public')
)

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)

try {
  $listener.Start()
} catch {
  Write-Error "Failed to start listener on localhost:$Port. $($_.Exception.Message)"
  exit 1
}

Write-Host "Serving $Root at http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."

function Get-ContentType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.html' { 'text/html; charset=utf-8' }
    '.htm' { 'text/html; charset=utf-8' }
    '.css' { 'text/css; charset=utf-8' }
    '.js' { 'application/javascript; charset=utf-8' }
    '.json' { 'application/json; charset=utf-8' }
    '.svg' { 'image/svg+xml' }
    '.png' { 'image/png' }
    '.jpg' { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    '.gif' { 'image/gif' }
    '.ico' { 'image/x-icon' }
    default { 'application/octet-stream' }
  }
}

function Resolve-FilePath {
  param([string]$UrlPath)

  if ([string]::IsNullOrWhiteSpace($UrlPath) -or $UrlPath -eq '/') {
    return (Join-Path $Root 'index.html')
  }

  $relativePath = $UrlPath.TrimStart('/')
  $candidate = Join-Path $Root $relativePath

  if (Test-Path $candidate -PathType Leaf) {
    return $candidate
  }

  if (-not [System.IO.Path]::GetExtension($candidate)) {
    $htmlCandidate = "$candidate.html"
    if (Test-Path $htmlCandidate -PathType Leaf) {
      return $htmlCandidate
    }
  }

  return $null
}

function Write-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$ContentType,
    [byte[]]$BodyBytes
  )

  $header = @(
    "HTTP/1.1 $StatusCode $StatusText"
    "Content-Type: $ContentType"
    "Content-Length: $($BodyBytes.Length)"
    "Connection: close"
    ""
    ""
  ) -join "`r`n"

  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($BodyBytes.Length -gt 0) {
    $Stream.Write($BodyBytes, 0, $BodyBytes.Length)
  }
  $Stream.Flush()
}

function Write-JsonResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    $Payload
  )

  $json = $Payload | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $statusText = if ($StatusCode -eq 200) { 'OK' } elseif ($StatusCode -eq 404) { 'Not Found' } elseif ($StatusCode -eq 501) { 'Not Implemented' } else { 'Error' }
  Write-Response -Stream $Stream -StatusCode $StatusCode -StatusText $statusText -ContentType 'application/json; charset=utf-8' -BodyBytes $bytes
}

function Handle-Request {
  param([System.Net.Sockets.TcpClient]$Client)

  $stream = $Client.GetStream()
  $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII)

  try {
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) {
      return
    }

    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line -or $line -eq '') {
        break
      }
    }

    $parts = $requestLine.Split(' ')
    if ($parts.Length -lt 2) {
      Write-Response -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -ContentType 'text/plain; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes('Bad Request'))
      return
    }

    $method = $parts[0]
    $path = $parts[1]

    switch -Regex ($path) {
      '^/api/me$' {
        Write-JsonResponse -Stream $stream -StatusCode 200 -Payload @{ user = $null }
        return
      }
      '^/api/projects$' {
        if ($method -eq 'GET') {
          Write-JsonResponse -Stream $stream -StatusCode 200 -Payload @()
        } else {
          Write-JsonResponse -Stream $stream -StatusCode 501 -Payload @{ error = 'Projects API needs the Node backend.' }
        }
        return
      }
      '^/api/projects/[^/]+$' {
        if ($method -eq 'GET') {
          Write-JsonResponse -Stream $stream -StatusCode 404 -Payload @{ error = 'Project not found.' }
        } else {
          Write-JsonResponse -Stream $stream -StatusCode 501 -Payload @{ error = 'Projects API needs the Node backend.' }
        }
        return
      }
      '^/api/generate$' {
        Write-JsonResponse -Stream $stream -StatusCode 501 -Payload @{ error = 'Generation needs the Node backend.' }
        return
      }
      '^/api/tool$' {
        Write-JsonResponse -Stream $stream -StatusCode 501 -Payload @{ error = 'Tools API needs the Node backend.' }
        return
      }
      '^/api/publish$' {
        Write-JsonResponse -Stream $stream -StatusCode 501 -Payload @{ error = 'Publish API needs the Node backend.' }
        return
      }
    }

    $filePath = Resolve-FilePath -UrlPath $path
    if ($null -eq $filePath) {
      Write-Response -Stream $stream -StatusCode 404 -StatusText 'Not Found' -ContentType 'text/plain; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes('Not Found'))
      return
    }

    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    Write-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType (Get-ContentType -Path $filePath) -BodyBytes $bytes
  } catch {
    $message = $_.Exception.Message
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
    Write-Response -Stream $stream -StatusCode 500 -StatusText 'Internal Server Error' -ContentType 'text/plain; charset=utf-8' -BodyBytes $bytes
  } finally {
    $reader.Dispose()
    $stream.Dispose()
    $Client.Dispose()
  }
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  Handle-Request -Client $client
}
