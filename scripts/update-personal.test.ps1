<#
.SYNOPSIS
    Focused unit and integration tests for scripts/update-personal.ps1.
    Uses injected adapters and native temporary directory fixtures.
#>

[CmdletBinding()]
param()

$Script:TestsRun = 0
$Script:TestsFailed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    $Script:TestsRun++
    if (-not $Condition) {
        $Script:TestsFailed++
        Write-Error "FAIL: $Message"
    } else {
        Write-Host "  PASS: $Message"
    }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    $Script:TestsRun++
    if ($Actual -ne $Expected) {
        $Script:TestsFailed++
        Write-Error "FAIL: $Message. Expected: '$Expected', Got: '$Actual'"
    } else {
        Write-Host "  PASS: $Message"
    }
}

function Assert-Throws([scriptblock]$Block, [string]$Pattern, [string]$Message) {
    $Script:TestsRun++
    $threw = $false
    $errMessage = ""
    try {
        & $Block
    } catch {
        $threw = $true
        $errMessage = $_.Exception.Message
    }

    if (-not $threw) {
        $Script:TestsFailed++
        Write-Error "FAIL: $Message. Expected exception matching '$Pattern', but no exception was thrown."
    } elseif ($Pattern -and ($errMessage -notmatch $Pattern)) {
        $Script:TestsFailed++
        Write-Error "FAIL: $Message. Exception message '$errMessage' did not match pattern '$Pattern'."
    } else {
        Write-Host "  PASS: $Message (threw as expected: $errMessage)"
    }
}

# Dot-source the script with -NoRun
$scriptPath = Join-Path $PSScriptRoot "update-personal.ps1"
. $scriptPath -NoRun

Write-Host "========================================================="
Write-Host "Running tests for update-personal.ps1"
Write-Host "========================================================="

# Setup native temporary fixtures for real path checks
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "paseo-ps-tests-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

$appDir = Join-Path $fixtureRoot "App"
if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    Assert-WindowsPlatform -LocalAdapters @{}
    Assert-True $true "Native Windows platform accepted"
} else {
    Assert-Throws {
        Assert-WindowsPlatform -LocalAdapters @{}
    } "designed for Windows" "Rejects non-Windows without adapters"
}

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
$appExe = Join-Path $appDir "Paseo.exe"
New-Item -ItemType File -Path $appExe -Force | Out-Null

$otherDir = Join-Path $fixtureRoot "AppOther"
New-Item -ItemType Directory -Path $otherDir -Force | Out-Null
$otherExe = Join-Path $otherDir "Paseo.exe"
New-Item -ItemType File -Path $otherExe -Force | Out-Null

try {
    # ---------------------------------------------------------------------------
    # Test Suite 1: Authentication & Safety
    # ---------------------------------------------------------------------------
    Write-Host "`n--- Test Suite 1: Auth & Embedded Terminal Safety ---"

    Assert-Throws {
        $env:PASEO_TERMINAL_ID = "term-123"
        try {
            Invoke-PersonalUpdate -ChosenInstallDir $appDir -LocalAdapters @{ Mock = $true }
        } finally {
            $env:PASEO_TERMINAL_ID = $null
        }
    } "embedded terminal" "Fails closed inside Paseo embedded terminal"

    Assert-Throws {
        Invoke-PersonalUpdate -ChosenInstallDir $appDir -LocalAdapters @{
            Gh = { param($CommandArgs) return @{ ExitCode = 1; Stdout = "auth error" } }
        }
    } "Must be authenticated with gh as 'Dvitash'" "Fails closed when gh auth exits non-zero"

    Assert-Throws {
        Invoke-PersonalUpdate -ChosenInstallDir $appDir -LocalAdapters @{
            Gh = { param($CommandArgs) return @{ ExitCode = 0; Stdout = "other-user`n" } }
        }
    } "Must be authenticated with gh as 'Dvitash'" "Fails closed when user is not Dvitash"

    # ---------------------------------------------------------------------------
    # Test Suite 2: Install Directory Discovery, Scopes & Ambiguity
    # ---------------------------------------------------------------------------
    Write-Host "`n--- Test Suite 2: Install Directory Resolution & Scopes ---"

    # Fails explicitly when no existing install exists
    Assert-Throws {
        Find-ExistingInstallDir -LocalAdapters @{
            GetProcesses = { return @() }
            GetRegLoc = { param($p) return $null }
        }
    } "No existing Paseo installation found to update" "Fails explicitly when no existing install exists"

    # Discovers via running Paseo process
    $procRes = Find-ExistingInstallDir -LocalAdapters @{
        GetProcesses = { return @([PSCustomObject]@{ Path = $appExe }) }
        GetRegLoc = { param($p) return $null }
    }
    Assert-Equal $procRes.Path $appDir "Discovers install dir from running Paseo process"

    # Discovers via HKLM registry -> Scope is allusers
    $hklmRes = Find-ExistingInstallDir -LocalAdapters @{
        GetProcesses = { return @() }
        GetRegLoc = {
            param($Key)
            if ($Key -like "HKLM:*ca8eee31-e786-591a-8405-a3710823b93a*") {
                return $appDir
            }
            return $null
        }
    }
    Assert-Equal $hklmRes.Path $appDir "Discovers install dir from HKLM derived GUID"
    Assert-Equal $hklmRes.Scope "allusers" "Preserves allusers scope from HKLM install"

    # Discovers via HKCU registry -> Scope is currentuser
    $hkcuRes = Find-ExistingInstallDir -LocalAdapters @{
        GetProcesses = { return @() }
        GetRegLoc = {
            param($Key)
            if ($Key -like "HKCU:*ca8eee31-e786-591a-8405-a3710823b93a*") {
                return $appDir
            }
            return $null
        }
    }
    Assert-Equal $hkcuRes.Scope "currentuser" "Preserves currentuser scope from HKCU install"

    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        $savedGuid = $NsisGuid
        $NsisGuid = [System.Guid]::NewGuid().ToString("D")
        $testKey = "HKCU:\Software\$NsisGuid"
        try {
            New-Item -Path $testKey -ErrorAction Stop | Out-Null
            New-ItemProperty -LiteralPath $testKey -Name InstallLocation -Value $appDir -PropertyType String -ErrorAction Stop | Out-Null
            $nativeTarget = Find-ExistingInstallDir -LocalAdapters @{ GetProcesses = { return @() } }
            Assert-Equal $nativeTarget.Path $appDir "Reads real NSIS InstallLocation registry key"
            Assert-Equal $nativeTarget.Scope "currentuser" "Reads native per-user installation scope"
        } finally {
            Remove-Item -LiteralPath $testKey -Recurse -Force -ErrorAction SilentlyContinue
            $NsisGuid = $savedGuid
        }
    }

    # Regression: running custom-path HKLM install (not Program Files) preserves allusers scope
    $customMachDir = Join-Path $fixtureRoot "CustomMachineApp"
    New-Item -ItemType Directory -Path $customMachDir -Force | Out-Null
    $customMachExe = Join-Path $customMachDir "Paseo.exe"
    New-Item -ItemType File -Path $customMachExe -Force | Out-Null

    $customProcHklmRes = Find-ExistingInstallDir -LocalAdapters @{
        GetProcesses = { return @([PSCustomObject]@{ Path = $customMachExe }) }
        GetRegLoc = {
            param($Key)
            if ($Key -like "HKLM:*ca8eee31-e786-591a-8405-a3710823b93a*") {
                return $customMachDir
            }
            return $null
        }
    }
    Assert-Equal $customProcHklmRes.Path $customMachDir "Discovers custom-path running app"
    Assert-Equal $customProcHklmRes.Scope "allusers" "Registry HKLM is authoritative over process path, sets allusers scope"

    # Regression: explicit -InstallDir matching HKLM registry preserves allusers scope
    $explicitHklmRes = Find-ExistingInstallDir -ExplicitDir $customMachDir -LocalAdapters @{
        GetRegLoc = {
            param($Key)
            if ($Key -like "HKLM:*ca8eee31-e786-591a-8405-a3710823b93a*") {
                return $customMachDir
            }
            return $null
        }
    }
    Assert-Equal $explicitHklmRes.Path $customMachDir "Explicit custom install dir accepted"
    Assert-Equal $explicitHklmRes.Scope "allusers" "Explicit dir preserves allusers scope from matching HKLM registry"

    # Ambiguity detection: fails closed when multiple distinct installations found
    Assert-Throws {
        Find-ExistingInstallDir -LocalAdapters @{
            GetProcesses = {
                return @(
                    [PSCustomObject]@{ Path = $appExe },
                    [PSCustomObject]@{ Path = $otherExe }
                )
            }
            GetRegLoc = { param($p) return $null }
        }
    } "Multiple conflicting Paseo installations detected" "Fails closed on multiple ambiguous installations"

    # ---------------------------------------------------------------------------
    # Test Suite 3: Path-Scoped Process Termination (Exact Path Check)
    # ---------------------------------------------------------------------------
    Write-Host "`n--- Test Suite 3: Path-Scoped Process Termination ---"

    $stopped = New-Object System.Collections.Generic.List[string]
    $mockProcs = @(
        [PSCustomObject]@{ Path = $appExe; Id = 101 },
        [PSCustomObject]@{ Path = $otherExe; Id = 102 } # Shares prefix with AppOther!
    )

    Stop-PaseoForInstall -TargetDir $appDir -LocalAdapters @{
        GetProcesses = { return $mockProcs }
        StopProcesses = {
            param($TargetProcs)
            foreach ($p in $TargetProcs) { $stopped.Add($p.Path) }
        }
    }

    Assert-Equal $stopped.Count 1 "Stopped exactly one process matching target executable"
    Assert-Equal $stopped[0] $appExe "Ignored process in AppOther despite path prefix similarity"

    $graceful = [PSCustomObject]@{ Path = $appExe; HasExited = $false; WaitBudget = 0 }
    $graceful | Add-Member ScriptMethod CloseMainWindow { return $true }
    $graceful | Add-Member ScriptMethod WaitForExit {
        param($Milliseconds)
        $this.WaitBudget = $Milliseconds
        $this.HasExited = $true
        return $true
    }
    Stop-PaseoForInstall -TargetDir $appDir -LocalAdapters @{ GetProcesses = { return @($graceful) } }
    Assert-True $graceful.HasExited "Waits for graceful application shutdown"
    Assert-True ($graceful.WaitBudget -gt 30000) "Allows detached daemon shutdown to finish"

    $blockedQuit = [PSCustomObject]@{ Path = $appExe; HasExited = $false }
    $blockedQuit | Add-Member ScriptMethod CloseMainWindow { return $false }
    $blockedQuit | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return $false }
    Assert-Throws {
        Stop-PaseoForInstall -TargetDir $appDir -LocalAdapters @{ GetProcesses = { return @($blockedQuit) } }
    } "did not quit cleanly" "Refuses installation when graceful quit is blocked"

    # ---------------------------------------------------------------------------
    # Test Suite 4: End-to-End Orchestration & Status Ordering / URL Matching
    # ---------------------------------------------------------------------------
    Write-Host "`n--- Test Suite 4: End-to-End Flow & Status Matching ---"

    # Actual artifact layout from personal update run 34281333436.
    $installerName = "Paseo-Setup-0.8.0-beta.1-x64.exe"
    $artifactFiles = @(
        "Paseo-Setup-0.8.0-beta.1-arm64.exe",
        "Paseo-Setup-0.8.0-beta.1-arm64.zip",
        $installerName,
        "Paseo-Setup-0.8.0-beta.1-x64.zip",
        "Paseo-Setup-0.8.0-beta.1.exe"
    )

    $flowState = @{
        DispatchedArgs = $null
        InstallerArg = $null
        TargetExeVerified = $false
    }

    # Test NDJSON line-by-line status parsing with pending stopping condition
    $mockAdapters = @{
        Guid = { return "test-fixed-uuid" }
        GetProcesses = { return @([PSCustomObject]@{ Path = $appExe }) }
        StopProcesses = { param($Processes) $flowState.Stopped = $true }
        LaunchDesktop = { param($Path) $flowState.Launched = $Path }
        RunInstaller = {
            param($Exe, $ArgStr)
            $flowState.InstallerExe = $Exe
            $flowState.InstallerArg = $ArgStr
            return 0
        }
        TestTargetExe = {
            param($Path)
            $flowState.TargetExeVerified = $true
            return $true
        }
        Gh = {
            param($CommandArgs)
            $sub = $CommandArgs[0]
            if ($sub -eq "api" -and $CommandArgs[1] -eq "user") {
                return @{ ExitCode = 0; Stdout = "Dvitash`n" }
            }
            if ($sub -eq "workflow" -and $CommandArgs[1] -eq "run") {
                $flowState.DispatchedArgs = $CommandArgs
                return @{ ExitCode = 0; Stdout = "" }
            }
            if ($sub -eq "run" -and $CommandArgs[1] -eq "list") {
                $runs = @(
                    @{
                        databaseId = 999
                        displayTitle = "Personal update test-fixed-uuid"
                        headSha = "sha-999"
                        url = "https://github.com/Dvitash/paseo/actions/runs/999"
                    }
                    @{
                        databaseId = 111
                        displayTitle = "Update Personal Daemon"
                        headSha = "old-sha"
                        url = "https://github.com/Dvitash/paseo/actions/runs/111"
                    }
                )
                if ($flowState.SingleRun) { $runs = @($runs[0]) }
                if ($flowState.InvalidRunId) { $runs[0].databaseId = "invalid-id" }
                return @{ ExitCode = 0; Stdout = (ConvertTo-Json -InputObject $runs -Depth 5) }
            }
            if ($sub -eq "run" -and $CommandArgs[1] -eq "view") {
                $flowState.ViewRunId = $CommandArgs[2]
                $view = @{ status = "completed"; conclusion = "success" }
                return @{ ExitCode = 0; Stdout = ($view | ConvertTo-Json) }
            }
            if ($sub -eq "run" -and $CommandArgs[1] -eq "download") {
                foreach ($name in $artifactFiles) {
                    New-Item -ItemType File -Path (Join-Path $CommandArgs[-1] $name) -Force | Out-Null
                }
                return @{ ExitCode = 0; Stdout = "" }
            }
            if ($sub -eq "api" -and $CommandArgs[1] -match "statuses") {
                # NDJSON: One JSON object per line as produced by --jq '.[]'
                # Matching run has success; older run 111 has success; different context has success
                $line1 = '{"context":"personal-daemon/spark-7e86","state":"success","target_url":"https://github.com/Dvitash/paseo/actions/runs/999","description":"Healthy"}'
                $line2 = '{"context":"personal-daemon/spark-7e86","state":"success","target_url":"https://github.com/Dvitash/paseo/actions/runs/111","description":"Old"}'
                $line3 = '{"context":"other-context","state":"success","target_url":"https://github.com/Dvitash/paseo/actions/runs/999","description":"Other"}'
                return @{ ExitCode = 0; Stdout = "$line1`n$line2`n$line3`n" }
            }
            return @{ ExitCode = 0; Stdout = "" }
        }
    }

    Invoke-PersonalUpdate -LocalAdapters $mockAdapters
    Assert-True ($flowState.DispatchedArgs -contains "desktop=windows-x64") "Dispatched with desktop=windows-x64"
    Assert-True ($flowState.DispatchedArgs -contains "request_id=test-fixed-uuid") "Dispatched with request_id"
    Assert-True ($flowState.InstallerArg -match "/S /currentuser /D=") "Installer called with /S /currentuser /D="
    Assert-Equal ([System.IO.Path]::GetFileName($flowState.InstallerExe)) $installerName "Selects the x64 installer from the actual multi-architecture artifact layout"
    Assert-True $flowState.TargetExeVerified "Target executable presence verified"
    Assert-Equal $flowState.Launched $appExe "Relaunches GUI only after both updates succeed"
    Assert-Equal $flowState.ViewRunId "999" "Selects a scalar run ID from a real multi-run JSON array"

    $flowState.SingleRun = $true
    $flowState.DispatchedArgs = $null
    Invoke-PersonalUpdate -ExistingRequestId "test-fixed-uuid" -LocalAdapters $mockAdapters
    Assert-True ($null -eq $flowState.DispatchedArgs) "Resume does not dispatch a duplicate update"
    Assert-Equal $flowState.ViewRunId "999" "Resumes the same run from a single-element JSON array"

    $flowState.InvalidRunId = $true
    $flowState.ViewRunId = $null
    Assert-Throws {
        Invoke-PersonalUpdate -ExistingRequestId "test-fixed-uuid" -LocalAdapters $mockAdapters
    } "convert" "Invalid run IDs terminate instead of continuing with an empty ID"
    Assert-True ($null -eq $flowState.ViewRunId) "No build query is sent after an invalid ID"
    $flowState.InvalidRunId = $false

    $completeArtifactFiles = $artifactFiles
    $artifactFiles = @($completeArtifactFiles | Where-Object { $_ -ne $installerName })
    $flowState.Stopped = $false
    $flowState.InstallerExe = $null
    Assert-Throws {
        Invoke-PersonalUpdate -ExistingRequestId "test-fixed-uuid" -LocalAdapters $mockAdapters
    } "Expected 1 x64 NSIS installer.*found 0" "Rejects artifacts containing only ARM64 and combined installers"
    Assert-True (-not $flowState.Stopped -and $null -eq $flowState.InstallerExe) "Missing x64 installer leaves the desktop untouched"

    $artifactFiles = @($completeArtifactFiles) + @("Paseo-Setup-0.8.0-beta.2-x64.exe")
    Assert-Throws {
        Invoke-PersonalUpdate -ExistingRequestId "test-fixed-uuid" -LocalAdapters $mockAdapters
    } "Expected 1 x64 NSIS installer.*found 2" "Rejects ambiguous x64 installers instead of choosing the first"
    Assert-True (-not $flowState.Stopped -and $null -eq $flowState.InstallerExe) "Ambiguous installers leave the desktop untouched"
    $artifactFiles = $completeArtifactFiles

    # Test partial failure if desktop installer fails after dispatch
    $failingInstallAdapters = @{
        Guid = { return "test-fail-uuid" }
        GetProcesses = { return @([PSCustomObject]@{ Path = $appExe }) }
        StopProcesses = { param($Processes) }
        RunInstaller = {
            param($Exe, $ArgStr)
            return 1 # Installer failed!
        }
        Gh = {
            param($CommandArgs)
            $sub = $CommandArgs[0]
            if ($sub -eq "api" -and $CommandArgs[1] -eq "user") { return @{ ExitCode = 0; Stdout = "Dvitash`n" } }
            if ($sub -eq "workflow" -and $CommandArgs[1] -eq "run") { return @{ ExitCode = 0; Stdout = "" } }
            if ($sub -eq "run" -and $CommandArgs[1] -eq "list") {
                return @{ ExitCode = 0; Stdout = (ConvertTo-Json -InputObject @(@{ databaseId = 888; displayTitle = "Personal update test-fail-uuid"; headSha = "s8"; url = "u8" })) }
            }
            if ($sub -eq "run" -and $CommandArgs[1] -eq "view") {
                return @{ ExitCode = 0; Stdout = (@{ status = "completed"; conclusion = "success" } | ConvertTo-Json) }
            }
            if ($sub -eq "run" -and $CommandArgs[1] -eq "download") {
                New-Item -ItemType File -Path (Join-Path $CommandArgs[-1] $installerName) -Force | Out-Null
                return @{ ExitCode = 0; Stdout = "" }
            }
            return @{ ExitCode = 0; Stdout = "" }
        }
    }

    Assert-Throws {
        Invoke-PersonalUpdate -LocalAdapters $failingInstallAdapters
    } "NSIS installer exited with code 1" "Reports failure when installer fails after dispatch"

} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n========================================================="
Write-Host "Test Results: $($Script:TestsRun) run, $($Script:TestsFailed) failed."
Write-Host "========================================================="

if ($Script:TestsFailed -gt 0) {
    exit 1
}
