# install-wechat.ps1 — Windows PowerShell 安装脚本（与 install-wechat.sh 等价）
# 用法:  .\install-wechat.ps1
#        .\install-wechat.ps1 -Profile desktop
# 推荐（公开发布路径，也是本机切换后的挂载方式）：
#   dsh plugin --profile desktop add github:zhengjy01/dsh-wechat-clawbot
# 本脚本是「本地 checkout 开发模式」的替代方案（junction 整个仓库，改代码即时生效）。
param(
    [string]$Profile = $env:DSH_PROFILE
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GatewayDir = Join-Path $ScriptDir 'wechat-gateway'

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
        if ((Test-Path (Join-Path $dir 'profiles\desktop')) -or
            (Test-Path (Join-Path $dir 'profiles\web')) -or
            (Test-Path (Join-Path $dir 'profiles\node_modules'))) {
            return $dir
        }
    }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Resolve-ProfileName {
    param([string]$DshHome, [string]$Requested)
    if ($Requested -and $Requested.Trim()) { return $Requested.Trim() }
    if (Test-Path (Join-Path $DshHome 'profiles\desktop')) { return 'desktop' }
    if (Test-Path (Join-Path $DshHome 'profiles\web')) { return 'web' }
    return 'web'
}

function Remove-DirLink {
    param([string]$Link)
    if (-not (Test-Path $Link)) { return }
    cmd /c "rmdir `"$Link`"" | Out-Null
    if (Test-Path $Link) {
        Remove-Item -Force -Recurse -LiteralPath $Link -ErrorAction SilentlyContinue
    }
}

function Link-Dir {
    param([string]$Target, [string]$Link)
    $parent = Split-Path -Parent $Link
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Remove-DirLink -Link $Link
    try {
        New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
        return
    } catch {
        cmd /c "mklink /J `"$Link`" `"$Target`"" | Out-Null
        if (-not (Test-Path $Link)) { throw "无法创建链接 $Link -> $Target" }
    }
}

function Add-PatchBlock {
    param([string]$PatchFile, [string]$Marker, [string]$Block)
    if ((Test-Path $PatchFile) -and (Select-String -Path $PatchFile -Pattern $Marker -Quiet)) {
        Write-Host "==> $PatchFile 已包含 $Marker，跳过注入"
        return
    }
    $parent = Split-Path -Parent $PatchFile
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (-not (Test-Path $PatchFile)) {
        Set-Content -Path $PatchFile -Value $Block -Encoding utf8
        Write-Host "==> 已注入 patch 行到 $PatchFile"
        return
    }
    $raw = Get-Content -Raw -Path $PatchFile
    $trimmed = ($raw -replace '\s', '')
    if ([string]::IsNullOrEmpty($trimmed) -or $trimmed -eq '[]') {
        Set-Content -Path $PatchFile -Value $Block -Encoding utf8
    } else {
        Add-Content -Path $PatchFile -Value "`n$Block" -Encoding utf8
    }
    Write-Host "==> 已注入 patch 行到 $PatchFile"
}

$DshHome = Resolve-DshHome
$ProfileName = Resolve-ProfileName -DshHome $DshHome -Requested $Profile
$ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
$ProfileNm = Join-Path $ProfileDir 'node_modules'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'

Write-Host "==> DSH home: $DshHome"
Write-Host "==> 目标 profile: $ProfileDir"
if (-not (Test-Path $ProfileDir)) {
    Write-Error "找不到 profile 目录（请先运行一次 DSH Desktop 或 dsh web，或设置 DSH_HOME / -Profile）"
}

if (-not (Test-Path (Join-Path $GatewayDir 'node_modules'))) {
    Write-Host '==> 安装 wechat-gateway 依赖（qrcode）...'
    Push-Location $GatewayDir
    npm install --no-audit --no-fund
    Pop-Location
} else {
    Write-Host '==> wechat-gateway 依赖已就绪'
}

$shimScript = Join-Path $ScriptDir 'scripts\link-peer-shims.mjs'
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host '==> 链接 bot / bridge peer 垫片...'
    node $shimScript
} else {
    Write-Warning '未找到 node，跳过 peer 垫片。请安装 Node.js，或改用 dsh plugin add。'
}

New-Item -ItemType Directory -Force -Path $ProfileNm | Out-Null
Link-Dir -Target $ScriptDir -Link (Join-Path $ProfileNm 'dsh-wechat-clawbot')
Write-Host '==> 已链接 profile node_modules/dsh-wechat-clawbot（宿主 + 悬浮球同一包）'

$patchBlock = @"
# 微信悬浮球桥接（dsh-wechat-clawbot bundle：宿主 + 悬浮球同包）
# 由 install-wechat.ps1 添加；删除本段即可卸载。
- insert:
    - id: wechat-bot
      name: dsh-wechat-clawbot
      config:
        sessionMode: active
        timeoutMs: 300000
        maxMessageChars: 20000
        approval: reject
"@

Add-PatchBlock -PatchFile $PatchFile -Marker 'wechat-bot' -Block $patchBlock

Write-Host ''
Write-Host '安装完成。下一步：'
Write-Host '  1. 重启 DeepSeek Harness / DSH Desktop。'
Write-Host '  2. 右下角出现微信绿色悬浮球 → 点击 → 用手机微信扫码登录。'
Write-Host '  3. 微信消息直接进入 DSH 会话，回复自动回传微信。'
