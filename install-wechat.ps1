# install-wechat.ps1 — Windows PowerShell 安装脚本（与 install-wechat.sh 等价）
# 用法:  .\install-wechat.ps1
# 推荐:  dsh plugin --profile web add github:lubaiUwU/DSH-WeChatClawBot

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GatewayDir = Join-Path $ScriptDir 'wechat-gateway'
$BotDir = Join-Path $ScriptDir 'dsh-wechat-bot'
$UiDir = Join-Path $ScriptDir 'dsh-client-wechat-ui'

function Resolve-DshHome {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) {
        return $env:DSH_HOME.Trim()
    }
    $candidates = @(
        (Join-Path $env:USERPROFILE '.dsh'),
        (Join-Path $env:APPDATA 'DeepSeekHarness'),
        (Join-Path $env:LOCALAPPDATA 'DeepSeekHarness')
    )
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir 'profiles\web')) {
            return $dir
        }
    }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Link-Dir {
    param([string]$Target, [string]$Link)
    $parent = Split-Path -Parent $Link
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $Link) { Remove-Item -Force -Recurse $Link }
    try {
        New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null
        return
    } catch {
        # Junction works without Developer Mode.
        cmd /c "mklink /J `"$Link`" `"$Target`"" | Out-Null
        if (-not (Test-Path $Link)) { throw "无法创建链接 $Link -> $Target" }
    }
}

$DshHome = Resolve-DshHome
$ProfileDir = Join-Path $DshHome 'profiles\web'
$FallbackNm = Join-Path $DshHome 'profiles\node_modules'
$ProfileNm = Join-Path $ProfileDir 'node_modules'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'

Write-Host "==> 目标 profile: $ProfileDir"
if (-not (Test-Path $ProfileDir)) {
    Write-Error "找不到 profile 目录（请先运行一次 dsh web，或设置 DSH_HOME）"
}

if (-not (Test-Path (Join-Path $GatewayDir 'node_modules'))) {
    Write-Host '==> 安装 wechat-gateway 依赖（qrcode）...'
    Push-Location $GatewayDir
    npm install --no-audit --no-fund
    Pop-Location
} else {
    Write-Host '==> wechat-gateway 依赖已就绪'
}

$Shim = Join-Path $BotDir 'node_modules'
$ShimDeepseek = Join-Path $Shim '@deepseek-ai'
New-Item -ItemType Directory -Force -Path $ShimDeepseek | Out-Null
foreach ($pkg in @('cordis', 'schemastery', 'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-settings')) {
    $src = Join-Path $FallbackNm "@deepseek-ai\$pkg"
    if (Test-Path $src) {
        Link-Dir -Target $src -Link (Join-Path $ShimDeepseek $pkg)
    }
}
Link-Dir -Target (Join-Path $ScriptDir 'dsh-wechat-bridge') -Link (Join-Path $Shim 'dsh-wechat-bridge')
Link-Dir -Target $BotDir -Link (Join-Path $ProfileNm 'dsh-wechat-bot')
Write-Host '==> 已链接 dsh-wechat-bot（含依赖垫片）'

Link-Dir -Target $UiDir -Link (Join-Path $ProfileNm 'dsh-client-wechat-ui')
Write-Host '==> 已链接 dsh-client-wechat-ui'

$patchBlock = @"

# 微信悬浮球桥接（dsh-wechat-bot + dsh-client-wechat-ui）
# 由 install-wechat.ps1 添加；删除本段即可卸载。
- insert:
    - id: wechat-bot
      name: dsh-wechat-bot
      config:
        gatewayPort: 51235
        sessionMode: active
        timeoutMs: 300000
        maxMessageChars: 20000
        approval: reject
    - id: wechat-ui
      name: dsh-client-wechat-ui
"@

if ((Test-Path $PatchFile) -and (Select-String -Path $PatchFile -Pattern 'wechat-bot' -Quiet)) {
    Write-Host "==> $PatchFile 已包含 wechat-bot，跳过注入"
} else {
    Add-Content -Path $PatchFile -Value $patchBlock -Encoding utf8
    Write-Host "==> 已注入 patch 行到 $PatchFile"
}

Write-Host ''
Write-Host '安装完成。下一步：'
Write-Host '  1. 重启 DeepSeek Harness 应用。'
Write-Host '  2. 右下角出现微信绿色悬浮球 → 点击 → 用手机微信扫码登录。'
Write-Host '  3. 微信消息直接进入 DSH 会话，回复自动回传微信。'
