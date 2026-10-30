param([Parameter(Mandatory = $true)][string]$Binary)

$ErrorActionPreference = 'Stop'
$metadata = & cargo metadata --no-deps --format-version 1 --locked | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '读取版本失败' }
$expectedVersion = ($metadata.packages | Where-Object name -eq 'pet-hook').version
$verificationDir = Join-Path ([IO.Path]::GetTempPath()) ('pet-hook-release-' + [guid]::NewGuid())
$previousStateDir = [Environment]::GetEnvironmentVariable('CCHUD_STATE_DIR')

try {
    # 验证真实的 PowerShell 调用,覆盖空格、单引号和变量符号,避免只断言生成的字符串。
    $installDir = Join-Path $verificationDir 'O''Brien $dev'
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $installedExe = Join-Path $installDir 'pet-hook.exe'
    Copy-Item -LiteralPath $Binary -Destination $installedExe
    $version = & $installedExe --version
    if ($LASTEXITCODE -ne 0 -or $version -ne "pet-hook $expectedVersion") { throw '二进制版本不匹配' }

    $settingsPath = Join-Path $verificationDir 'hooks.json'
    & $installedExe setup --client codex --settings $settingsPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '安装钩子失败' }
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    $env:CCHUD_STATE_DIR = Join-Path $verificationDir 'state'
    $recordPath = Join-Path $env:CCHUD_STATE_DIR 'release-smoke.json'

    foreach ($eventName in @('PreToolUse', 'PermissionRequest', 'Interrupt', 'SessionEnd')) {
        $command = $settings.hooks.$eventName[0].hooks[0].command
        $eventJson = @{ session_id = 'release-smoke'; hook_event_name = $eventName; tool_name = 'apply_patch'; tool_use_id = 'call-1' } | ConvertTo-Json -Compress
        $hookOutput = $eventJson | & ([ScriptBlock]::Create('$input | ' + $command))
        if ($LASTEXITCODE -ne 0 -or $hookOutput) { throw "$eventName 执行失败或污染 stdout" }
        if ($eventName -eq 'SessionEnd') {
            if (Test-Path -LiteralPath $recordPath) { throw '会话状态没有清理' }
            if (Test-Path -LiteralPath (Join-Path $env:CCHUD_STATE_DIR 'release-smoke.calls')) { throw '调用标记没有清理' }
        } else {
            $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
            $expected = switch ($eventName) { 'PreToolUse' { 'edit' }; 'PermissionRequest' { 'wait' }; 'Interrupt' { 'idle' } }
            if ($record.state -ne $expected -or $record.source -ne 'codex') { throw "$eventName 状态不匹配" }
        }
    }
    & $installedExe setup --client codex --settings $settingsPath --uninstall | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '卸载钩子失败' }
    $remaining = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($remaining.PSObject.Properties.Name -contains 'hooks') { throw '卸载没有清理自己的钩子' }
    Write-Output 'Windows 发行二进制的版本、PowerShell 调用与安装清理验证通过'
} finally {
    [Environment]::SetEnvironmentVariable('CCHUD_STATE_DIR', $previousStateDir)
    if (Test-Path -LiteralPath $verificationDir) { Remove-Item -LiteralPath $verificationDir -Recurse -Force }
}
