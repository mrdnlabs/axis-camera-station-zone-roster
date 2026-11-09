# Builds windows\bin\ZoneRosterSetup.exe, a single installer containing the app, this machine's Node.js, the
# service host and the tray icon. Uses the C# compiler that ships with Windows.
[CmdletBinding()]
param([string]$OutDir)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'bin' }
$RepoRoot = Split-Path $PSScriptRoot -Parent
$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Invoke-Csc([string]$Target, [string]$Name, [string[]]$References, [string[]]$Sources, [string[]]$Options) {
    $refs = $References | ForEach-Object { "/reference:$_" }
    $files = @("$Name.cs") + @($Sources | Where-Object { $_ }) | ForEach-Object { Join-Path $PSScriptRoot $_ }
    & $csc /nologo /optimize+ "/target:$Target" "/out:$(Join-Path $OutDir "$Name.exe")" $refs $Options $files
    if ($LASTEXITCODE -ne 0) { throw "$Name failed to compile" }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 20 or newer is required to build the installer and was not found on PATH.' }
if ([int](& $node -p "process.versions.node.split('.')[0]") -lt 20) { throw 'Node.js 20 or newer is required.' }

Invoke-Csc 'exe' 'ZoneRosterService' @('System.ServiceProcess.dll', 'System.Security.dll') @('Secrets.cs')
$icon = "/win32icon:$(Join-Path $PSScriptRoot 'zone-roster.ico')"
Invoke-Csc 'winexe' 'ZoneRosterTray' @('System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll') @() @($icon)

# Everything the installer writes, in its installed layout.
$stage = Join-Path $OutDir 'payload'
$zip = Join-Path $OutDir 'payload.zip'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
if (Test-Path $zip) { Remove-Item -Force $zip }
New-Item -ItemType Directory -Path (Join-Path $stage 'app') | Out-Null
foreach ($item in 'src', 'public', 'package.json') { Copy-Item -Recurse (Join-Path $RepoRoot $item) (Join-Path $stage 'app') }
Copy-Item (Join-Path $RepoRoot 'config.example.json') $stage
Copy-Item $node (Join-Path $stage 'node.exe')
Copy-Item (Join-Path $OutDir 'ZoneRosterService.exe'), (Join-Path $OutDir 'ZoneRosterTray.exe') $stage
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -Recurse -Force $stage

Invoke-Csc 'winexe' 'ZoneRosterSetup' @('System.Windows.Forms.dll', 'System.Drawing.dll', 'System.ServiceProcess.dll', 'System.Security.dll', 'System.Web.Extensions.dll', 'System.IO.Compression.dll', 'System.Core.dll') @('Secrets.cs') @($icon, "/resource:$zip,payload.zip", "/win32manifest:$(Join-Path $PSScriptRoot 'setup.manifest')")
Remove-Item -Force $zip
Write-Host "Built $(Join-Path $OutDir 'ZoneRosterSetup.exe')"
