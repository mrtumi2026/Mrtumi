Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\sj010\.gemini\antigravity\brain\df1ce63c-a8a8-482e-af4a-0d01729f0282\.user_uploaded\media_1794247304877_c6bc3c93.jpg"
$src = [System.Drawing.Image]::FromFile($srcPath)

function Create-SquareIcon([int]$size, [string]$destPath) {
    $parent = Split-Path -Parent $destPath
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    
    # White background
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $gfx.FillRectangle($brush, 0, 0, $size, $size)
    
    # Fit source into square preserving aspect ratio with 5% padding
    $padding = [int]($size * 0.05)
    $availW = $size - ($padding * 2)
    $availH = $size - ($padding * 2)
    
    $ratio = [Math]::Min([double]$availW / $src.Width, [double]$availH / $src.Height)
    $destW = [int]($src.Width * $ratio)
    $destH = [int]($src.Height * $ratio)
    $destX = [int](($size - $destW) / 2)
    $destY = [int](($size - $destH) / 2)
    
    $gfx.DrawImage($src, $destX, $destY, $destW, $destH)
    $bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
    
    $gfx.Dispose()
    $bmp.Dispose()
    Write-Host "Created: $destPath ($size x $size)"
}

$root = "C:\Users\sj010\.gemini\antigravity\scratch\Mrtumi"

# 1. Web & PWA Icons
Create-SquareIcon 512 "$root\public\uploads\brand\mrtumi-app-icon.png"
Create-SquareIcon 192 "$root\public\uploads\brand\mrtumi-app-icon-192.png"
Create-SquareIcon 64  "$root\public\uploads\brand\mrtumi-favicon.png"
Create-SquareIcon 512 "$root\public\uploads\settings\logo.png"

# 2. Android Customer App Mipmaps
$androidCustomer = "$root\android\customer-app\app\src\main\res"
Create-SquareIcon 48  "$androidCustomer\mipmap-mdpi\ic_launcher.png"
Create-SquareIcon 72  "$androidCustomer\mipmap-hdpi\ic_launcher.png"
Create-SquareIcon 96  "$androidCustomer\mipmap-xhdpi\ic_launcher.png"
Create-SquareIcon 144 "$androidCustomer\mipmap-xxhdpi\ic_launcher.png"
Create-SquareIcon 192 "$androidCustomer\mipmap-xxxhdpi\ic_launcher.png"
Create-SquareIcon 512 "$androidCustomer\drawable\ic_launcher.png"

# Round icons for Android
Create-SquareIcon 48  "$androidCustomer\mipmap-mdpi\ic_launcher_round.png"
Create-SquareIcon 72  "$androidCustomer\mipmap-hdpi\ic_launcher_round.png"
Create-SquareIcon 96  "$androidCustomer\mipmap-xhdpi\ic_launcher_round.png"
Create-SquareIcon 144 "$androidCustomer\mipmap-xxhdpi\ic_launcher_round.png"
Create-SquareIcon 192 "$androidCustomer\mipmap-xxxhdpi\ic_launcher_round.png"

# 3. Android Partner App Mipmaps
$androidPartner = "$root\android\partner-app\app\src\main\res"
Create-SquareIcon 48  "$androidPartner\mipmap-mdpi\ic_launcher.png"
Create-SquareIcon 72  "$androidPartner\mipmap-hdpi\ic_launcher.png"
Create-SquareIcon 96  "$androidPartner\mipmap-xhdpi\ic_launcher.png"
Create-SquareIcon 144 "$androidPartner\mipmap-xxhdpi\ic_launcher.png"
Create-SquareIcon 192 "$androidPartner\mipmap-xxxhdpi\ic_launcher.png"
Create-SquareIcon 512 "$androidPartner\drawable\ic_launcher.png"

Create-SquareIcon 48  "$androidPartner\mipmap-mdpi\ic_launcher_round.png"
Create-SquareIcon 72  "$androidPartner\mipmap-hdpi\ic_launcher_round.png"
Create-SquareIcon 96  "$androidPartner\mipmap-xhdpi\ic_launcher_round.png"
Create-SquareIcon 144 "$androidPartner\mipmap-xxhdpi\ic_launcher_round.png"
Create-SquareIcon 192 "$androidPartner\mipmap-xxxhdpi\ic_launcher_round.png"

# 4. iOS App Icons
$iosDir = "$root\ios\MrTumi\Assets.xcassets\AppIcon.appiconset"
Create-SquareIcon 1024 "$iosDir\AppIcon-1024.png"
Create-SquareIcon 180  "$iosDir\AppIcon-180.png"
Create-SquareIcon 120  "$iosDir\AppIcon-120.png"
Create-SquareIcon 87   "$iosDir\AppIcon-87.png"
Create-SquareIcon 60   "$iosDir\AppIcon-60.png"

$src.Dispose()
Write-Host "All icons generated successfully!"
