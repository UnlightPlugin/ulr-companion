# 牌譜、記牌、復盤

2026-10-23 開工。四件事共用同一條資料線：

```
頁面 patch-kifu ──回報──▶ engine kifu-recorder ──▶ @ulr/kifu 存放區 (~/.ulr-companion/battle)
   │  (每場的原始事件)            │  (打完補版本快照)                │
   │                              ▼                                  ▼
頁面 patch-card-count        托盤「戰鬥 › 牌譜」            buildReplay → 播放器
   (即時記牌面板)              播放器視窗／遊戲裡播            (托盤視窗、遊戲內共用 viewer.js)
```

## 錄什麼

**每場戰鬥 MainA 那條 socket 收到的每一則事件原樣存**，加上自己送出的操作（房號、token 換成 `~id`）。
不自己養戰況狀態機 —— 2026-09-23 改版把戰鬥事件全部改名，自己整理過的格式那天就會全部作廢。
原始事件留著，整理的程式（`replay.ts`）修好了舊牌譜可以重算。

- 掛在 `MainA.prototype.init`：官方 init 同步那一段就設好 socket，原本的 init 一回來就掛 `onAny`，
  開場第一則就錄得到（`partial: false`）。插件中途才接上走輪詢、標 `partial`。
- `result` 那則 onAny 收不到（官方收到就 `socket.off()`），改包 `game_result` 記。
- 隱藏資訊：伺服器本來就不送對手手牌（`drawPhase` 只給張數、`card_submit_opponent` 只給位置，
  `cardOpen_*` 翻開才有牌面）。唯一例外是開場的 `room_config` 帶著對手整副牌組 —— 只留角色卡 id。
- 2026-10-23 改版後的事件語意（`card_submit_player`、`move_power` 相對順序、`damage_*` 第 4 參數…）
  寫在 `packages/kifu/src/replay.ts` 檔頭的對照表。

## 版本快照：改版後照當時的樣子播

打完那一刻（結算畫面，戰鬥貼圖還沒卸）engine 對頁面要：

| 什麼                                     | 怎麼拿                                          | 存成                        |
| ---------------------------------------- | ----------------------------------------------- | --------------------------- |
| 10 份資料表（CharaCards、Feats、State…） | Phaser JSON 快取原文                            | `store/tables/<sha>.json`   |
| 戰鬥中畫過的貼圖＋官方 loader 清單       | **遊戲記憶體裡解碼好的圖用畫布匯出成無損 WebP** | `store/blobs/<sha>.webp`    |
| 每張貼圖的切法（含點陣字字形）           | Phaser texture frames                           | `store/textures/<sha>.json` |
| 數字字型 BradleyGratis                   | 遊戲載入時的網址（快取）                        | `store/blobs/<sha>.otf`     |

全部內容定址：同一個版本的東西不管錄幾場只存一份，改版後內容變了雜湊就變，舊牌譜指著的還是舊的。
第一場約 10～25 MB，之後每場只多牌譜本身（幾百 KB）。

⚠ **不碰網路**。官方把圖 fetch 成 blob 解碼完就 revoke，原始網址的網域每次登入都換、而且從
`UL_CONFIG.domains.assets.urls` 兩個裡隨機挑 —— 猜錯就變成真的向官方伺服器發請求。
⚠ 巨型圖集（頭像部件 2048²、卡背、卡面）只切這場畫過的那幾格；角色卡圖照雙方牌組指定。
⚠ 還沒存到：技能特效圖（官方每階段臨時載入、用完就卸，打完再要已經不在）。

## 記牌

每個地點一疊固定的公牌（`public-decks.ts`，由 `tools/build-public-decks.mjs` 從 Moon 的公牌記錄產生），
每張帶 index。**沒看過的牌 = 牌堆剩餘 + 對手蓋著的公牌**（2026-10-23 實錄一場 419 步每一步都成立，
含兩次洗牌）。洗牌時看過的清空、只剩雙方手上看得到的。表跟實際抽到的牌對不上（改版換牌）就不顯示。

遊戲內面板在左上牌堆張數下面（右下會被一頁 9 張的手牌蓋住），字照官方 Bonus 那行。所有模式都開，托盤可關。

## 播放

`apps/tray/renderer/kifu/viewer.js`：Canvas 2D，畫快照裡的圖，座標照官方戰鬥畫面（BackA／MainA 實測）。
不用 Phaser、不用遊戲自己的 MainA —— 那樣會綁死在當前版本。

- 托盤：「戰鬥 › 牌譜」→ 播放（獨立視窗；時間軸、步驟清單、記牌表）
- 遊戲裡：→ 遊戲裡（蓋在遊戲畫布上，← → 換步、空白鍵播放、Esc 關；戰鬥中不開）
- 對手還沒亮相的角色（`known: false`）照官方畫成 `LV ? ATK ? DEF ?`。

## 雙視角合併（`merge.ts`）

同一場兩個座位各錄一份（`meta.roomHash` 相同）。官方的 `opponent_card` 跟對方的 `player_card` 是同一串
事件依序 push 的，所以索引對得上；先驗證所有翻開過的牌兩邊一致才合併。補上的牌標 `peek`，
畫在上方、跟當時看得到的分開。上傳到 Worker 互通還沒做（要部署、要決定預設）。
