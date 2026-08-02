<#
.SYNOPSIS
  免 Steam 開一個遊戲分頁。

.DESCRIPTION
  帶 debug port 的瀏覽器沒在跑就自己開一個，然後重建官方外殼、用 SteamID 直連。
  完全不經過 Steam —— 換帳號就是換 -SteamId，跟 Steam 客戶端登入的是誰無關。

  只想要一個帶 debug port 的瀏覽器、進去自己點書籤的話，用 -BrowserOnly，
  那條路不需要 SteamID。

  ⚠ SteamID 不寫在這個檔案裡。這個腳本會進版控，而規格書 §12 明訂 steamid
  不得記錄。用參數傳，或設一次環境變數：

      setx ULR_STEAMID 76561199...        # 設定（開新的終端機才生效）

  ⚠ 這個檔案必須存成 **UTF-8 with BOM**。PowerShell 5.1 讀沒有 BOM 的檔案
  會當成系統 ANSI 碼頁（這台機器是 CP950），中文註解會被解碼成亂碼，其中
  剛好湊出引號就會炸成 ParserError —— 症狀是「字串遺漏結尾字元」，指到的
  行數還跟真正的問題無關。

.EXAMPLE
  .\tools\open-game.ps1 -BrowserOnly
  只開瀏覽器，進去點書籤。

.EXAMPLE
  .\tools\open-game.ps1
  用 $env:ULR_STEAMID 直接開好遊戲分頁。

.EXAMPLE
  .\tools\open-game.ps1 -SteamId 76561199... -Port 9335 -ProfileDir C:\Users\me\ulr-cdp-2
  開小號。各自一個 port 與 profile，兩邊互不干擾。

  ⚠ 但同 IP 兩個帳號**同時**在線會被伺服器擋。實測可行的組合是網頁版掛
    瀏覽器 VPN、桌面版走本機 IP（見 docs/battle-features.md）。
#>
[CmdletBinding()]
param(
  [string]$SteamId = $env:ULR_STEAMID,
  [int]$Port,
  # ⚠ 不要叫 $Profile —— 那是 PowerShell 的自動變數（使用者設定檔路徑），
  # 拿來當參數名會在腳本內把它蓋掉。
  [Alias('Profile')]
  [string]$ProfileDir,
  # 遊戲的 WebSocket port（14012~14021）。不給就隨機挑。
  [int]$GamePort,
  # 只開瀏覽器，不開遊戲分頁。這條不需要 SteamID。
  [switch]$BrowserOnly,
  # 先重讀一次當前版本的 bundle 檔名（遊戲改版後才需要，會用到 Steam）。
  [switch]$Refresh
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$entry = "apps/companion/src/index.ts"

# 三個子指令共用的選項，一次組好。
$common = @()
if ($Port) { $common += @("--port", "$Port") }
if ($ProfileDir) { $common += @("--profile", $ProfileDir) }

# 沒給 SteamID 就只開瀏覽器 —— 那是最常走的路（進去點書籤就好，書籤裡本來
# 就帶著身分）。硬性要求 SteamID 只會逼人在不需要的時候去翻自己的那串數字。
if ($BrowserOnly -or -not $SteamId) {
  if (-not $BrowserOnly) {
    Write-Host "沒有 SteamID，只開瀏覽器。進去點書籤即可。"
    Write-Host "（想直接開好遊戲分頁：-SteamId <SteamID64> 或 setx ULR_STEAMID <SteamID64>）"
  }
  npx tsx $entry browser @common
  exit $LASTEXITCODE
}

if ($Refresh) {
  # 改版後才需要。唯一還會用到 Steam 的一步 —— 伺服器沒有版本端點，也不刪舊
  # bundle，所以確認檔名是最新的唯一辦法就是讓遊戲真的再正常載入一次。
  npx tsx $entry web --refresh @common
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$openArgs = @("--steamid", $SteamId) + $common
if ($GamePort) { $openArgs += @("--game-port", "$GamePort") }

npx tsx $entry web @openArgs
exit $LASTEXITCODE
