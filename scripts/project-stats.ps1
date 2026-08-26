<#
.SYNOPSIS
    统计项目文件数量与总大小，并按扩展名分组，最后输出 Markdown 表格。

.DESCRIPTION
    递归扫描项目根目录（默认取脚本所在目录的上一级），
    排除 node_modules、.git、dist、build（任意层级同名目录均跳过），
    统计文件总数、总大小，以及各扩展名的文件数与大小，
    结果以 Markdown 表格形式输出到控制台。

.EXAMPLE
    .\scripts\project-stats.ps1

.EXAMPLE
    .\scripts\project-stats.ps1 -Path D:\Projects\MyApp
#>
[CmdletBinding()]
param(
    # 要统计的项目根目录；默认取脚本所在目录的上一级（即项目根）
    [string]$Path = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

# 需要排除的目录名（任意层级同名目录均跳过）
$ExcludeDirs = @('node_modules', '.git', 'dist', 'build')

# 把字节数格式化为人类可读大小
function Format-Bytes {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return '{0:N2} GB' -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return '{0:N2} MB' -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return '{0:N2} KB' -f ($Bytes / 1KB) }
    return '{0:N0} B' -f $Bytes
}

# 递归收集文件：跳过排除目录与重解析点（联接/符号链接），避免循环遍历
function Get-ProjectFiles {
    param(
        [string]$Directory,
        [string[]]$Exclude
    )
    foreach ($child in Get-ChildItem -LiteralPath $Directory -Force -ErrorAction SilentlyContinue) {
        if ($Exclude -contains $child.Name) { continue }
        if ($child.PSIsContainer) {
            if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
            Get-ProjectFiles -Directory $child.FullName -Exclude $Exclude
        }
        else {
            $child
        }
    }
}

$root = (Resolve-Path -LiteralPath $Path).Path
Write-Host "正在扫描：$root（排除：$($ExcludeDirs -join ', ')）" -ForegroundColor Cyan

$files = @(Get-ProjectFiles -Directory $root -Exclude $ExcludeDirs)

# 基本统计
$totalFiles = $files.Count
$totalBytes = if ($files.Count -gt 0) {
    [double]($files | Measure-Object -Property Length -Sum).Sum
}
else { 0 }

# 按扩展名分组（无扩展名的文件归入“(无扩展名)”）
$grouped = $files |
    Group-Object -Property { if ($_.Extension) { $_.Extension } else { '(无扩展名)' } } |
    Sort-Object @{ Expression = 'Count'; Descending = $true }, Name

# 生成 Markdown
$lines = @(
    '# 项目文件统计'
    ''
    '- 扫描目录：``{0}``' -f $root
    '- 文件总数：**{0:N0}**' -f $totalFiles
    '- 总大小：**{0}**（{1:N0} 字节）' -f (Format-Bytes $totalBytes), $totalBytes
    ''
    '## 按扩展名统计'
    ''
    '| 扩展名 | 文件数 | 占比 | 总大小 |'
    '| --- | ---: | ---: | ---: |'
)

foreach ($g in $grouped) {
    $size = [double]($g.Group | Measure-Object -Property Length -Sum).Sum
    $pct  = if ($totalFiles -gt 0) { '{0:P1}' -f ($g.Count / $totalFiles) } else { '-' }
    $lines += '| ``{0}`` | {1:N0} | {2} | {3} |' -f $g.Name, $g.Count, $pct, (Format-Bytes $size)
}

$lines += @(
    ''
    '## 总计'
    ''
    '| 指标 | 值 |'
    '| --- | ---: |'
    '| 文件总数 | {0:N0} |' -f $totalFiles
    '| 总大小 | {0} |' -f (Format-Bytes $totalBytes)
    '| 扩展名种类 | {0} |' -f $grouped.Count
)

# 输出 Markdown（最后一步）
$lines -join "`n"
