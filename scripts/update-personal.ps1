<#
.SYNOPSIS
    Updates local Windows Paseo desktop in-place and triggers/waits for daemon update on spark-7e86.
#>

[CmdletBinding()]
param(
    [Parameter()]
    [string]$InstallDir,

    [Parameter()]
    [string]$RequestId,

    [Parameter()]
    [switch]$NoRun,

    [Parameter()]
    [hashtable]$Adapters = @{}
)

$Repo = "Dvitash/paseo"
$Workflow = "personal-update-daemon.yml"
$ExpectedOwner = "Dvitash"
$DaemonContext = "personal-daemon/spark-7e86"
$NsisGuid = "ca8eee31-e786-591a-8405-a3710823b93a"

function Assert-WindowsPlatform {
    param([hashtable]$LocalAdapters)
    if ($LocalAdapters -and $LocalAdapters.Count -gt 0) { return }
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw "update-personal.ps1 is designed for Windows. To update the remote daemon from other platforms, use the GitHub Actions web interface or API."
    }
}

function Invoke-Gh {
    param(
        [string[]]$CommandArgs,
        [int]$TimeoutSeconds = 60,
        [hashtable]$LocalAdapters
    )
    if ($LocalAdapters -and $LocalAdapters.ContainsKey("Gh")) {
        return & $LocalAdapters["Gh"] $CommandArgs
    }
    $ghCmd = Get-Command "gh" -ErrorAction SilentlyContinue
    if (-not $ghCmd) {
        throw "GitHub CLI ('gh') was not found on PATH. Install gh and authenticate with 'gh auth login'."
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ghCmd.Source
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $escapedArgs = @()
    foreach ($a in $CommandArgs) {
        if ($a -match '[\s"]') {
            $escapedArgs += ('"' + ($a -replace '(\\*)(")', '$1$1\"') + '"')
        } else {
            $escapedArgs += $a
        }
    }
    $psi.Arguments = ($escapedArgs -join " ")

    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { $proc.Kill() } catch {}
        throw "GitHub CLI command timed out after ${TimeoutSeconds}s: gh $($psi.Arguments)"
    }
    [System.Threading.Tasks.Task]::WaitAll($outTask, $errTask)
    $stdout = $outTask.Result
    $stderr = $errTask.Result
    if ($proc.ExitCode -ne 0 -and -not [string]::IsNullOrWhiteSpace($stderr)) {
        $stdout += "`n" + $stderr
    }

    return @{ ExitCode = $proc.ExitCode; Stdout = $stdout }
}

function Get-NsisRegistryLocations {
    # InstallLocation is stored separately from Windows' uninstall metadata.
    return @(
        @{ Key = "HKLM:\Software\$NsisGuid"; Scope = "allusers" },
        @{ Key = "HKLM:\Software\WOW6432Node\$NsisGuid"; Scope = "allusers" },
        @{ Key = "HKCU:\Software\$NsisGuid"; Scope = "currentuser" }
    )
}

function Get-RegistryScopeForDir {
    param(
        [string]$Dir,
        [hashtable]$LocalAdapters
    )
    $regPaths = Get-NsisRegistryLocations
    foreach ($entry in $regPaths) {
        $loc = if ($LocalAdapters -and $LocalAdapters.ContainsKey("GetRegLoc")) {
            & $LocalAdapters["GetRegLoc"] $entry.Key
        } else {
            (Get-ItemProperty -LiteralPath $entry.Key -ErrorAction SilentlyContinue).InstallLocation
        }
        if ($loc -and [string]::Equals($loc.Trim().TrimEnd('\', '/'), $Dir.Trim().TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
            return $entry.Scope
        }
    }
    return $null
}

function Find-ExistingInstallDir {
    param(
        [string]$ExplicitDir,
        [hashtable]$LocalAdapters
    )
    if (-not [string]::IsNullOrWhiteSpace($ExplicitDir)) {
        $resolved = [System.IO.Path]::GetFullPath($ExplicitDir).TrimEnd('\', '/')
        if (-not (Test-Path -LiteralPath (Join-Path $resolved "Paseo.exe"))) {
            throw "Specified -InstallDir '$resolved' does not contain Paseo.exe."
        }
        $regScope = Get-RegistryScopeForDir -Dir $resolved -LocalAdapters $LocalAdapters
        $scope = if ($regScope) { $regScope } elseif ($resolved -like "*Program Files*") { "allusers" } else { "currentuser" }
        return @{ Path = $resolved; Scope = $scope }
    }

    $candidates = New-Object System.Collections.Generic.List[hashtable]

    # 1. Inspect electron-builder derived NSIS GUID in registry (authoritative)
    $regPaths = Get-NsisRegistryLocations
    foreach ($entry in $regPaths) {
        $loc = if ($LocalAdapters -and $LocalAdapters.ContainsKey("GetRegLoc")) {
            & $LocalAdapters["GetRegLoc"] $entry.Key
        } else {
            (Get-ItemProperty -LiteralPath $entry.Key -ErrorAction SilentlyContinue).InstallLocation
        }
        if ($loc) {
            $dir = $loc.Trim().TrimEnd('\', '/')
            if (Test-Path -LiteralPath (Join-Path $dir "Paseo.exe")) {
                $already = $false
                foreach ($c in $candidates) { if ($c.Path -eq $dir) { $already = $true; break } }
                if (-not $already) {
                    $candidates.Add(@{ Path = $dir; Scope = $entry.Scope })
                }
            }
        }
    }

    # 2. Inspect running Paseo processes (registry authoritative if matched)
    $procs = @(if ($LocalAdapters -and $LocalAdapters.ContainsKey("GetProcesses")) {
        & $LocalAdapters["GetProcesses"]
    } else {
        Get-Process -Name "Paseo" -ErrorAction SilentlyContinue
    })
    foreach ($p in $procs) {
        $exe = $p.Path
        if ($exe -and (Test-Path -LiteralPath $exe)) {
            $dir = [System.IO.Path]::GetDirectoryName($exe).TrimEnd('\', '/')
            $already = $false
            foreach ($c in $candidates) {
                if ($c.Path -eq $dir) {
                    $already = $true
                    $regScope = Get-RegistryScopeForDir -Dir $dir -LocalAdapters $LocalAdapters
                    if ($regScope) { $c.Scope = $regScope }
                    break
                }
            }
            if (-not $already) {
                $regScope = Get-RegistryScopeForDir -Dir $dir -LocalAdapters $LocalAdapters
                $scope = if ($regScope) { $regScope } elseif ($dir -like "*Program Files*") { "allusers" } else { "currentuser" }
                $candidates.Add(@{ Path = $dir; Scope = $scope })
            }
        }
    }

    # 3. Check electron-builder default per-user directory
    if ($env:LOCALAPPDATA) {
        $defaultUserDir = Join-Path $env:LOCALAPPDATA "Programs\Paseo"
        if (Test-Path -LiteralPath (Join-Path $defaultUserDir "Paseo.exe")) {
            $already = $false
            foreach ($c in $candidates) { if ($c.Path -eq $defaultUserDir) { $already = $true; break } }
            if (-not $already) {
                $regScope = Get-RegistryScopeForDir -Dir $defaultUserDir -LocalAdapters $LocalAdapters
                $scope = if ($regScope) { $regScope } else { "currentuser" }
                $candidates.Add(@{ Path = $defaultUserDir; Scope = $scope })
            }
        }
    }
    if ($candidates.Count -eq 0) {
        throw "No existing Paseo installation found to update. Ensure Paseo is installed or specify -InstallDir."
    }
    if ($candidates.Count -gt 1) {
        $paths = @($candidates | ForEach-Object { $_.Path }) -join ', '
        throw "Multiple conflicting Paseo installations detected ($paths). Specify -InstallDir explicitly."
    }
    return $candidates[0]
}

function Stop-PaseoForInstall {
    param(
        [string]$TargetDir,
        [hashtable]$LocalAdapters
    )
    $expectedExe = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "Paseo.exe")).TrimEnd('\', '/')

    $procs = @(if ($LocalAdapters -and $LocalAdapters.ContainsKey("GetProcesses")) {
        & $LocalAdapters["GetProcesses"]
    } else {
        Get-Process -Name "Paseo" -ErrorAction SilentlyContinue
    })

    $targetProcs = @($procs | Where-Object {
        $_.Path -and [string]::Equals([System.IO.Path]::GetFullPath($_.Path).TrimEnd('\', '/'), $expectedExe, [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($targetProcs.Count -eq 0) { return }

    if ($LocalAdapters -and $LocalAdapters.ContainsKey("StopProcesses")) {
        & $LocalAdapters["StopProcesses"] $targetProcs
        return
    }

    # Let Electron's quit hook stop its detached local daemon before files change.
    foreach ($p in $targetProcs) {
        try { $null = $p.CloseMainWindow() } catch { if (-not $p.HasExited) { throw } }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    foreach ($p in $targetProcs) {
        $remaining = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $p.HasExited -and -not $p.WaitForExit($remaining)) {
            throw "Paseo did not quit cleanly. Quit it from the app, then retry; installation has not started."
        }
    }
}

function Invoke-PersonalUpdate {
    param(
        [string]$ChosenInstallDir,
        [string]$ExistingRequestId,
        [hashtable]$LocalAdapters
    )
    $ErrorActionPreference = "Stop"

    Assert-WindowsPlatform -LocalAdapters $LocalAdapters

    if ($env:PASEO_TERMINAL_ID) {
        throw "Running inside Paseo embedded terminal. Closing Paseo will terminate this update. Run in standalone PowerShell."
    }

    Write-Host "Authenticating gh as $ExpectedOwner..."
    $auth = Invoke-Gh -CommandArgs @("api", "user", "--jq", ".login") -LocalAdapters $LocalAdapters
    if ($auth.ExitCode -ne 0 -or ($auth.Stdout.Trim() -ne $ExpectedOwner)) {
        throw "Must be authenticated with gh as '$ExpectedOwner'. Current: '$($auth.Stdout.Trim())'."
    }

    $installTarget = Find-ExistingInstallDir -ExplicitDir $ChosenInstallDir -LocalAdapters $LocalAdapters
    $targetDir = $installTarget.Path
    $targetScope = $installTarget.Scope
    Write-Host "Target install directory: $targetDir (scope: $targetScope)"

    $requestId = $ExistingRequestId
    if ([string]::IsNullOrWhiteSpace($requestId)) {
        $requestId = if ($LocalAdapters -and $LocalAdapters.ContainsKey("Guid")) {
            & $LocalAdapters["Guid"]
        } else {
            [System.Guid]::NewGuid().ToString("D")
        }
        Write-Host "Dispatching workflow $Workflow with request_id: $requestId..."
        $dispatch = Invoke-Gh -CommandArgs @("workflow", "run", $Workflow, "--repo", $Repo, "--ref", "main", "-f", "desktop=windows-x64", "-f", "request_id=$requestId") -LocalAdapters $LocalAdapters
        if ($dispatch.ExitCode -ne 0) { throw "Workflow dispatch failed: $($dispatch.Stdout)" }
    } else {
        Write-Host "Resuming existing request: $requestId (no new workflow dispatch)."
    }

    $expectedTitle = "Personal update $requestId"
    $run = $null
    for ($i = 0; $i -lt 30; $i++) {
        $list = Invoke-Gh -CommandArgs @("run", "list", "--repo", $Repo, "--workflow", $Workflow, "--json", "databaseId,displayTitle,headSha,url", "-L", "10") -LocalAdapters $LocalAdapters
        if ($list.ExitCode -eq 0) {
            # PS 5.1 preserves JSON arrays as one pipeline value; @() would nest it.
            $runs = ConvertFrom-Json $list.Stdout
            foreach ($r in $runs) {
                if ($r.displayTitle -eq $expectedTitle) {
                    if ($null -ne $run) { throw "Multiple runs match request '$requestId'; refusing ambiguous update." }
                    $run = $r
                }
            }
        }
        if ($run) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $run) { throw "Timed out locating run '$expectedTitle'." }
    if ($run -is [array] -or $run.databaseId -is [array]) {
        throw "Expected exactly one workflow run."
    }
    $runId = [long]$run.databaseId
    if ($runId -le 0) { throw "Invalid workflow run ID." }
    $headSha = $run.headSha

    Write-Host "Waiting for build $runId ($($run.url))..."
    $completed = $false
    for ($i = 0; $i -lt 180; $i++) {
        $view = Invoke-Gh -CommandArgs @("run", "view", "$runId", "--repo", $Repo, "--json", "status,conclusion") -LocalAdapters $LocalAdapters
        if ($view.ExitCode -eq 0) {
            $v = ConvertFrom-Json $view.Stdout
            if ($v.status -eq "completed") {
                if ($v.conclusion -ne "success") { throw "Workflow build failed with conclusion '$($v.conclusion)'." }
                $completed = $true
                break
            }
        }
        Start-Sleep -Seconds 10
    }
    if (-not $completed) { throw "Workflow build timed out." }

    # Desktop install stage: wrap in try/catch to report clear partial failure after dispatch
    $tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "paseo-update-$([System.Guid]::NewGuid().ToString('N'))")
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    try {
        $artName = "paseo-desktop-windows-x64-$headSha"
        Write-Host "Downloading $artName..."
        $dl = Invoke-Gh -CommandArgs @("run", "download", "$runId", "--repo", $Repo, "--name", $artName, "--dir", $tempDir) -TimeoutSeconds 600 -LocalAdapters $LocalAdapters
        if ($dl.ExitCode -ne 0) { throw "Failed downloading artifact: $($dl.Stdout)" }

        $exes = @(if ($LocalAdapters -and $LocalAdapters.ContainsKey("GetExes")) {
            & $LocalAdapters["GetExes"] $tempDir
        } else {
            Get-ChildItem -Path $tempDir -Filter "*.exe" -File
        })
        if ($exes.Count -ne 1) { throw "Expected 1 installer executable in artifact, found $($exes.Count)." }
        $installer = if ($exes[0] -is [string]) { $exes[0] } else { $exes[0].FullName }

        Stop-PaseoForInstall -TargetDir $targetDir -LocalAdapters $LocalAdapters

        Write-Host "Installing in-place to $targetDir ($targetScope)..."
        $scopeFlag = if ($targetScope -eq "allusers") { "/allusers" } else { "/currentuser" }
        $argString = "/S $scopeFlag /D=$targetDir"
        $exitCode = if ($LocalAdapters -and $LocalAdapters.ContainsKey("RunInstaller")) {
            & $LocalAdapters["RunInstaller"] $installer $argString
        } else {
            $proc = Start-Process -FilePath $installer -ArgumentList $argString -Wait -PassThru
            $proc.ExitCode
        }
        if ($exitCode -ne 0) { throw "NSIS installer exited with code $exitCode." }
        $targetExe = Join-Path $targetDir "Paseo.exe"
        $verified = if ($LocalAdapters -and $LocalAdapters.ContainsKey("TestTargetExe")) {
            & $LocalAdapters["TestTargetExe"] $targetExe
        } else {
            Test-Path -LiteralPath $targetExe
        }
        if (-not $verified) {
            throw "Installation verification failed: Paseo.exe not found at $targetDir."
        }
    } catch {
        Write-Error @"
=========================================================
PARTIAL UPDATE OUTCOME:
- Workflow dispatched: https://github.com/$Repo/actions/runs/$runId (commit $headSha). Daemon update on spark-7e86 may continue independently.
- Local desktop update FAILED: $_
=========================================================
"@
        throw $_
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Poll daemon commit status using --jq '.[]' NDJSON line-by-line parsing
    $targetUrl = "https://github.com/$Repo/actions/runs/$runId"
    Write-Host "Waiting for daemon commit status on spark-7e86 (matching $targetUrl)..."
    $daemonSuccess = $false
    for ($i = 0; $i -lt 90; $i++) {
        $statusRes = Invoke-Gh -CommandArgs @("api", "repos/$Repo/commits/$headSha/statuses", "--paginate", "--jq", ".[]") -LocalAdapters $LocalAdapters
        if ($statusRes.ExitCode -eq 0) {
            $lines = @(($statusRes.Stdout -split "[\r\n]+") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            $matching = $null
            foreach ($line in $lines) {
                try {
                    $s = ConvertFrom-Json $line
                    if ($s.context -eq $DaemonContext -and $s.target_url -eq $targetUrl) {
                        $matching = $s
                        break
                    }
                } catch {}
            }
            if ($matching) {
                if ($matching.state -eq "success") {
                    $daemonSuccess = $true
                    break
                }
                if ($matching.state -in "failure", "error") {
                    Write-Error @"
=========================================================
PARTIAL UPDATE OUTCOME:
- Desktop GUI: SUCCESS (updated in-place at '$targetDir')
- Daemon update: FAILED on spark-7e86: $($matching.description)
=========================================================
"@
                    throw "Desktop updated successfully, but daemon update failed on spark-7e86: $($matching.description)"
                }
                # Pending: remain in poll loop, do not check older statuses
            }
        }
        if ($daemonSuccess) { break }
        Start-Sleep -Seconds 10
    }

    if (-not $daemonSuccess) {
        Write-Error @"
=========================================================
PARTIAL UPDATE OUTCOME:
- Desktop GUI: SUCCESS (updated in-place at '$targetDir')
- Daemon update: TIMED OUT waiting for spark-7e86 ($targetUrl)
=========================================================
"@
        throw "Desktop updated successfully, but timed out waiting for spark-7e86 daemon update."
    }

    if ($LocalAdapters -and $LocalAdapters.ContainsKey("LaunchDesktop")) {
        & $LocalAdapters["LaunchDesktop"] $targetExe
    } else {
        Start-Process -FilePath $targetExe -ErrorAction Stop | Out-Null
    }

    Write-Host @"
=========================================================
Paseo personal update complete!
- Desktop: $targetDir ($targetScope)
- Daemon:  spark-7e86 ($headSha)
- Run:     $targetUrl
=========================================================
"@
}

if (-not $NoRun) {
    Invoke-PersonalUpdate -ChosenInstallDir $InstallDir -ExistingRequestId $RequestId -LocalAdapters $Adapters
}
