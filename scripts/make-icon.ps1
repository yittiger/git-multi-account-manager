# 图标生成脚本：把一张方形 PNG 转成 Windows 多尺寸 .ico
# ------------------------------------------------------------------
# 作者：yittiger
# 用法（在项目根目录）：
#   powershell -File scripts\make-icon.ps1
# 输入：build\icon-source.png（建议 1024×1024 及以上，带透明通道）
# 输出：build\icon.ico（内嵌 16/24/32/48/64/128/256 七个 PNG 尺寸）
#       build\icon.png（256×256，供非 Windows 平台使用）
# 说明：ICO 内嵌 PNG 的依据是 Vista 之后支持的 PNG 压缩图标格式，
#       electron-builder 与 Windows 资源管理器都能正确识别。

param(
  [string]$Source = (Join-Path $PSScriptRoot '..\build\icon-source.png'),
  [string]$IcoPath = (Join-Path $PSScriptRoot '..\build\icon.ico'),
  [string]$PngPath = (Join-Path $PSScriptRoot '..\build\icon.png'),
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Source)) {
  throw "找不到源图：$Source"
}

$src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
Write-Host "源图尺寸：$($src.Width)x$($src.Height)，像素格式：$($src.PixelFormat)"

$entries = @()

foreach ($size in $Sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.DrawImage($src, 0, 0, $size, $size)
  $graphics.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $entries += , @($size, $ms.ToArray())

  if ($size -eq 256) {
    # 256 尺寸同时留一份 PNG，供 electron-builder 在 mac/linux 上使用
    [System.IO.File]::WriteAllBytes($PngPath, $ms.ToArray())
  }

  $ms.Dispose()
  $bmp.Dispose()
  Write-Host "  ✓ 生成 $size x $size"
}

# ---------- 按 ICO 规范拼装二进制 ----------
$stream = New-Object System.IO.MemoryStream
$stream.Write([BitConverter]::GetBytes([uint16]0), 0, 2)              # reserved
$stream.Write([BitConverter]::GetBytes([uint16]1), 0, 2)              # type = icon
$stream.Write([BitConverter]::GetBytes([uint16]$entries.Count), 0, 2) # 图像数量

$offset = 6 + 16 * $entries.Count
foreach ($entry in $entries) {
  $size = $entry[0]
  $data = $entry[1]
  # 宽高用 1 字节表示，256 记作 0
  $dim = if ($size -ge 256) { 0 } else { $size }
  $stream.Write([BitConverter]::GetBytes([byte]$dim), 0, 1)   # width
  $stream.Write([BitConverter]::GetBytes([byte]$dim), 0, 1)   # height
  $stream.Write([BitConverter]::GetBytes([byte]0), 0, 1)      # color count
  $stream.Write([BitConverter]::GetBytes([byte]0), 0, 1)      # reserved
  $stream.Write([BitConverter]::GetBytes([uint16]1), 0, 2)    # planes
  $stream.Write([BitConverter]::GetBytes([uint16]32), 0, 2)   # bit count
  $stream.Write([BitConverter]::GetBytes([uint32]$data.Length), 0, 4)
  $stream.Write([BitConverter]::GetBytes([uint32]$offset), 0, 4)
  $offset += $data.Length
}

foreach ($entry in $entries) {
  $data = $entry[1]
  $stream.Write($data, 0, $data.Length)
}

[System.IO.File]::WriteAllBytes($IcoPath, $stream.ToArray())
$stream.Dispose()
$src.Dispose()

# ---------- 自检：能被 .NET 正常读回 ----------
$icon = New-Object System.Drawing.Icon((Resolve-Path -LiteralPath $IcoPath).Path)
Write-Host "输出：$IcoPath（默认读取尺寸 $($icon.Width)x$($icon.Height)）"
$icon.Dispose()
Write-Host "输出：$PngPath"
