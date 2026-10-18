<#
.SYNOPSIS
  開一個帶 debug port 的瀏覽器，進去用 Steam 登入擴充開遊戲。

.DESCRIPTION
  帶 debug port 的瀏覽器沒在跑就自己開一個。遊戲在裡面用 Steam 登入擴充開
  （托盤 設置 › 網頁版），插件就接得上。

  ⚠ 以前的「-SteamId 重建官方外殼直連」2026-10-15 起登不進去了（官方開始驗
  access_token），已拿掉。-SteamId 還收，但只會提醒一句。

  ⚠ 這個檔案必須存成 **UTF-8 with BOM**。PowerShell 5.1 讀沒有 BOM 的檔案
  會當成系統 ANSI 碼頁（這台機器是 CP950），中文註解會被解碼成亂碼，其中
  剛好湊出引號就會炸成 ParserError —— 症狀是「字串遺漏結尾字元」，指到的
  行數還跟真正的問題無關。

.EXAMPLE
  .\tools\open-game.ps1
  開瀏覽器，進去用 Steam 登入擴充開遊戲。

.EXAMPLE
  .\tools\open-game.ps1 -Port 9335 -ProfileDir C:\Users\me\ulr-cdp-2
  開小號。各自一個 port 與 profile，兩邊互不干擾（擴充要在那個 profile 裡也裝一次）。

  ⚠ 但同 IP 兩個帳號**同時**在線會被伺服器擋。實測可行的組合是網頁版掛
    瀏覽器 VPN、桌面版走本機 IP（見 docs/battle-features.md）。
#>
[CmdletBinding()]
param(
  # 舊的直連參數。還收著，免得舊捷徑一跑就是「找不到參數」，但只提醒一句。
  [string]$SteamId,
  [int]$Port,
  # ⚠ 不要叫 $Profile —— 那是 PowerShell 的自動變數（使用者設定檔路徑），
  # 拿來當參數名會在腳本內把它蓋掉。
  [Alias('Profile')]
  [string]$ProfileDir,
  # 舊參數，現在本來就只開瀏覽器。
  [switch]$BrowserOnly
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$entry = "apps/companion/src/index.ts"

$common = @()
if ($Port) { $common += @("--port", "$Port") }
if ($ProfileDir) { $common += @("--profile", $ProfileDir) }

if ($SteamId) {
  Write-Host "⚠ SteamID 直連 10/15 改版後登不進去了，只開瀏覽器。進去用 Steam 登入擴充開遊戲。"
}
npx tsx $entry browser @common
exit $LASTEXITCODE
