---
name: game-data
description: 查 UNLIGHT 的靜態遊戲資料 —— 卡片 cost、角色數值與升級素材、武器與事件卡效果、任務 QP 效率、劇情文本、成就與稱號。已經爬好放在 unlight_crawler repo，是 CSV。任何「某張卡多少 cost / 某角色 L4 幾點 / 哪個任務 CP 值高 / 那張武器什麼效果」都用這個，不要去戳跑著的遊戲。
---

# 查遊戲資料

**這些資料已經爬好了，不必開遊戲、不必問伺服器。** 來源是
`E:\unlight_crawler`（另一個 repo，`mike-ul-dev/unlight_crawler`）。

⚠ 先分清楚你要查的是**資料**還是**行為**：

| 要查的                                   | 用哪個        |
| ---------------------------------------- | ------------- |
| cost、數值、素材、任務、文本 —— **資料** | 這份          |
| 場景、按鈕、事件、座標、時序 —— **行為** | `/probe-game` |

crawler 裡**沒有客戶端原始碼** —— `crawler.py:32` 的
`EXCLUDE_KEYWORDS = ["phaser"]` 刻意排除了引擎 bundle。

## 檔案在哪、有什麼

全部在 `E:\unlight_crawler\steam\data\`。

### cost 與數值

| 檔案               | 欄位                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `cost_cc_pure.csv` | `chara_id,name_ja,name_tcn,L1..L5,R1..R5` —— **一角色一列**                         |
| `cost_cc.csv`      | `name,level,cost,hp,atk,def,slot` —— **一等級一列**，含 HP/ATK/DEF                  |
| `cost_weapon.csv`  | `idx,name_tcn,name_ja,cost,melee/ranged_attack,melee/ranged_defense,info_*,chara_*` |
| `cost_event.csv`   | `idx,name,info_ja,info_tcn,cost,color`                                              |
| `cc_require.csv`   | `chara_name,rare_level,` 五種碎片 `,混沌元素,其他` —— 升級素材                      |

**兩份 cost_cc 是不同形狀，別搞混**：`cost_cc_pure` 是寬表（適合查「這角色
各等級 cost」），`cost_cc` 是長表且**多了 HP/ATK/DEF 與 slot 顏色**（適合查
「這張卡的實際數值」）。

`name` 欄是 `日文 / 繁中` 合併的（`エヴァリスト / 艾伯李斯特`），比對時要切開。

⚠ **`chara_name + level` 不是唯一鍵** —— L4 與 R4 分不出來。要正規鍵請用
`cc_asset` 的 filename，見記憶 `unlight-cc-asset-key`。這條直接影響
open-questions #1。

### 任務效率

`qp.csv`：`land,region,region_ap,quest,quest_ap,quest_star,quest_point,total_ap,qp_per_ap`

`qp_per_ap` 是**已經算好的 CP 值**，要排「刷哪張圖划算」直接 sort 這欄。

### 文本

| 檔案                                          | 內容                    |
| --------------------------------------------- | ----------------------- |
| `queststory.txt` / `queststory_curse.txt`     | 任務劇情                |
| `map_mobile_ja.txt` / `_tcn.txt`（各 ~700KB） | 地圖／關卡文本，最大宗  |
| `achievement_500_ja.txt` / `_tcn.txt`         | 成就                    |
| `title.txt`                                   | 稱號                    |
| `news_*.txt`                                  | 五種語言的公告          |
| `lot.txt` / `lot_cc.txt`                      | 抽獎（`lot_cc` 是空的） |

repo 根目錄另有 `story/`、`story_md/`（劇情，md 版可讀性好）、`html/`、
`website/`、`ulgg/`。

## 怎麼查

CSV 用 Read 直接看就好，都不大（最大 `qp.csv` 144KB）。要篩選再用
`Select-String` 或寫個小 script。**不要用 Grep 工具搜整個 repo** ——
`map_mobile_*.txt` 兩份加起來 1.4MB，會把結果淹掉。

```powershell
# 例：查某角色各等級 cost
Select-String -Path E:\unlight_crawler\steam\data\cost_cc.csv -Pattern "艾伯李斯特"

# 例：QP 效率前 10
Import-Csv E:\unlight_crawler\steam\data\qp.csv |
  Sort-Object { [double]$_.qp_per_ap } -Descending |
  Select-Object -First 10 quest, qp_per_ap
```

## ⚠ 資料是快照，不是即時的

這是**某次爬取當下**的遊戲狀態。改版後 cost 會變，而 CSV 不會自己更新。
拿它跟遊戲內實際數值對不上時，先懷疑資料舊了，不要先懷疑程式。

重爬要去 `E:\unlight_crawler` 跑它自己的爬蟲（`src/`，Python，
用 `E:\Python312\python.exe`）。

## ⚠ 版控界線

`E:\unlight_crawler` 是**另一個 repo**。在 `E:\ulr-companion` 工作時
**不要 commit 它的檔案**，要用就複製需要的欄位進來、註明來源與爬取時間。

`C:\Users\AzuMeow\Desktop\Unlight` 則是**絕對不可進版控** —— `battle/`、
`deck/` 的 log 含 Steam session token。
