param(
    [switch]$SkipPrerequisites,
    [switch]$SkipCloudflared
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Project  = Join-Path $RepoRoot "MAGO_Viewer_CLIENT_BDD_ACCES"
$Api      = Join-Path $Project "api\mago-enrichment-api"
$SqlMain  = Join-Path $Api "sql\000_mago_schema.sql"
$SqlAccess = Join-Path $Api "sql\002_client_access_database.sql"

function Write-Step([string]$Text) {
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
}

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Npm {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = "C:\Program Files\nodejs\npm.cmd"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Find-PgBin {
    $candidates = @()
    $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($psqlCmd) { $candidates += (Split-Path $psqlCmd.Source -Parent) }
    $candidates += "C:\PGSQL\pgsql\bin"
    $candidates += Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "bin" }

    foreach ($dir in ($candidates | Select-Object -Unique)) {
        if ($dir -and (Test-Path (Join-Path $dir "psql.exe"))) { return $dir }
    }
    return $null
}

function Ensure-WingetPackage([string]$Id, [switch]$Interactive) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "winget is required to install $Id. Install App Installer from Microsoft Store, then restart this script."
    }
    $args = @("install", "--id", $Id, "--exact", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements")
    if ($Interactive) { $args += "--interactive" } else { $args += "--silent" }
    & winget.exe @args
    if ($LASTEXITCODE -ne 0) { throw "winget installation failed for $Id (code $LASTEXITCODE)." }
    Refresh-Path
}

if (-not (Test-Administrator)) {
    Write-Host "Administrator rights are required. Reopening the installer..." -ForegroundColor Yellow
    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $MyInvocation.MyCommand.Path + '"'))
    if ($SkipPrerequisites) { $args += "-SkipPrerequisites" }
    if ($SkipCloudflared) { $args += "-SkipCloudflared" }
    Start-Process powershell.exe -Verb RunAs -ArgumentList ($args -join " ")
    exit
}

if (-not (Test-Path (Join-Path $Project "package.json"))) { throw "Viewer project not found: $Project" }
if (-not (Test-Path (Join-Path $Api "package.json"))) { throw "API project not found: $Api" }
if (-not (Test-Path $SqlMain)) { throw "Missing SQL schema: $SqlMain" }
if (-not (Test-Path $SqlAccess)) { throw "Missing access SQL schema: $SqlAccess" }

Refresh-Path

if (-not $SkipPrerequisites) {
    Write-Step "1/8 - Prerequisites"

    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        Ensure-WingetPackage "OpenJS.NodeJS.LTS"
    }

    if (-not (Find-PgBin)) {
        Write-Host "PostgreSQL 16 will now be installed." -ForegroundColor Yellow
        Write-Host "During setup, choose and remember the postgres password." -ForegroundColor Yellow
        Ensure-WingetPackage "PostgreSQL.PostgreSQL.16" -Interactive
    }

    if (-not $SkipCloudflared -and -not (Get-Command cloudflared.exe -ErrorAction SilentlyContinue)) {
        Ensure-WingetPackage "Cloudflare.cloudflared"
    }
}

Refresh-Path
$Npm = Find-Npm
$PgBin = Find-PgBin
if (-not $Npm) { throw "npm.cmd was not found. Install Node.js LTS and restart." }
if (-not $PgBin) { throw "PostgreSQL command-line tools were not found." }

$Psql = Join-Path $PgBin "psql.exe"
$Createdb = Join-Path $PgBin "createdb.exe"
if (-not (Test-Path $Createdb)) { throw "createdb.exe was not found in $PgBin" }

Write-Step "2/8 - Start PostgreSQL"
$PgService = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "postgresql*" } |
    Sort-Object Name -Descending |
    Select-Object -First 1

if ($PgService) {
    if ($PgService.Status -ne "Running") {
        Start-Service $PgService.Name
        $PgService.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
    }
    Write-Host "PostgreSQL service: $($PgService.Name) ($($PgService.Status))" -ForegroundColor Green
}
else {
    $PortableData = "C:\PGSQL\pgdata"
    $PgCtl = Join-Path $PgBin "pg_ctl.exe"
    if ((Test-Path $PgCtl) -and (Test-Path (Join-Path $PortableData "PG_VERSION"))) {
        & $PgCtl -D $PortableData -l "C:\PGSQL\postgresql.log" start | Out-Null
        Start-Sleep -Seconds 3
    }
    else {
        throw "No PostgreSQL service or portable data directory was found."
    }
}

$SecurePassword = Read-Host "PostgreSQL password for user postgres" -AsSecureString
$Bstr = [IntPtr]::Zero
$PostgresPassword = $null

try {
    $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
    $PostgresPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    $env:PGPASSWORD = $PostgresPassword

    & $Psql -h localhost -p 5432 -U postgres -d postgres -tAc "SELECT current_database();"
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL connection failed. Check the postgres password." }

    Write-Step "3/8 - Create empty databases"
    foreach ($Database in @("mago_enrichment", "mago_access")) {
        $Exists = ((& $Psql -h localhost -p 5432 -U postgres -d postgres -tAc "SELECT count(*) FROM pg_database WHERE datname='$Database';") | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Cannot check database $Database." }
        if ($Exists -eq "0") {
            & $Createdb -h localhost -p 5432 -U postgres -E UTF8 $Database
            if ($LASTEXITCODE -ne 0) { throw "Cannot create database $Database." }
            Write-Host "Created: $Database" -ForegroundColor Green
        }
        else {
            Write-Host "Already present: $Database" -ForegroundColor Yellow
        }
    }

    Write-Step "4/8 - Initialize clean schemas"
    & $Psql -h localhost -p 5432 -U postgres -d mago_enrichment -v ON_ERROR_STOP=1 -f $SqlMain
    if ($LASTEXITCODE -ne 0) { throw "Initialization of mago_enrichment failed." }

    & $Psql -h localhost -p 5432 -U postgres -d mago_access -v ON_ERROR_STOP=1 -f $SqlAccess
    if ($LASTEXITCODE -ne 0) { throw "Initialization of mago_access failed." }

    Write-Step "5/8 - Generate local .env"
    $RandomBytes = New-Object byte[] 32
    $Rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $Rng.GetBytes($RandomBytes)
    $Rng.Dispose()
    $JwtSecret = ([BitConverter]::ToString($RandomBytes)).Replace("-", "").ToLowerInvariant()
    $EnvPassword = $PostgresPassword.Replace('\', '\\').Replace('"', '\"')

    $EnvContent = @"
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD="$EnvPassword"
PGDATABASE=mago_enrichment
ACCESS_PGDATABASE=mago_access
PORT=3001
CLIENT_PUBLIC_BASE_URL=http://localhost:3001
JWT_SECRET=$JwtSecret
CLIENT_TOKEN_TTL=12h
CLIENT_EXPIRY_TIMEZONE=Europe/Paris
CLIENT_AUTH_REQUIRED=false
STORAGE_DIR=./storage
CLIENT_LOCAL_VIEWER_URL=http://localhost:3001
"@

    $EnvPath = Join-Path $Api ".env"
    if (Test-Path $EnvPath) {
        Copy-Item $EnvPath ($EnvPath + ".backup_" + (Get-Date -Format "yyyyMMdd_HHmmss")) -Force
    }
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($EnvPath, $EnvContent.Trim(), $Utf8NoBom)
    Write-Host "Created locally (never commit): $EnvPath" -ForegroundColor Green

    Write-Step "6/8 - Install Node dependencies"
    & $Npm config set registry "https://registry.npmjs.org/" --location=user | Out-Null

    foreach ($Lock in @((Join-Path $Project "package-lock.json"), (Join-Path $Api "package-lock.json"))) {
        if (Test-Path $Lock) {
            $LockText = [IO.File]::ReadAllText($Lock)
            [IO.File]::WriteAllText($Lock, $LockText, $Utf8NoBom)
        }
    }

    Push-Location $Project
    try {
        & $Npm ci --registry="https://registry.npmjs.org/"
        if ($LASTEXITCODE -ne 0) { throw "Frontend npm ci failed." }
    }
    finally { Pop-Location }

    Push-Location $Api
    try {
        & $Npm ci --registry="https://registry.npmjs.org/"
        if ($LASTEXITCODE -ne 0) { throw "API npm ci failed." }
    }
    finally { Pop-Location }

    Write-Step "7/8 - Build Viewer"
    Push-Location $Project
    try {
        & $Npm run build
        if ($LASTEXITCODE -ne 0) { throw "Viewer build failed." }
    }
    finally { Pop-Location }

    Write-Step "8/8 - Desktop shortcut and health test"
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $ShortcutPath = Join-Path $Desktop "MAGO Viewer.lnk"
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Project\LANCER_MAGO_VIEWER.ps1`""
    $Shortcut.WorkingDirectory = $Project
    $Icon = Get-ChildItem $Project -Filter "*.ico" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Icon) { $Shortcut.IconLocation = $Icon.FullName }
    $Shortcut.Save()

    $ApiLog = Join-Path $Api "mago-api-install-test.log"
    $ApiErr = Join-Path $Api "mago-api-install-test.err.log"
    $ApiProcess = Start-Process cmd.exe -WindowStyle Hidden -PassThru -RedirectStandardOutput $ApiLog -RedirectStandardError $ApiErr -ArgumentList @(
        "/c", "cd /d `"$Api`" && `"$Npm`" start"
    )

    $Healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $Response = Invoke-WebRequest "http://127.0.0.1:3001/api/health" -UseBasicParsing -TimeoutSec 2
            if ($Response.StatusCode -eq 200) { $Healthy = $true; break }
        }
        catch {}
    }

    if (-not $Healthy) {
        if ($ApiProcess -and -not $ApiProcess.HasExited) { Stop-Process -Id $ApiProcess.Id -Force -ErrorAction SilentlyContinue }
        throw "The API health test failed. See $ApiErr"
    }

    Write-Host "`nMAGO Viewer clean installation completed." -ForegroundColor Green
    Write-Host "API health: OK" -ForegroundColor Green
    Write-Host "Desktop shortcut: $ShortcutPath" -ForegroundColor Green
    Write-Host "No project or client data was installed." -ForegroundColor Green
    Start-Process "http://localhost:3001/"
}
finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    if ($Bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }
    $PostgresPassword = $null
}
