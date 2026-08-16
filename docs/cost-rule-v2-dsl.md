# schemaVersion 2 設計草案：可宣告的規則

**狀態：草案，還沒實作。** 這份把「玩家想得出來的平衡手段」整理成一個
受限的宣告式格式，並且先把七條實際需求當成驗收測試 —— 先有測試再設計 schema，
比先做一個「萬能規則語言」穩得多。

前置閱讀：[official-cost-rule.md](official-cost-rule.md)（原版怎麼算）、
[open-questions.md](open-questions.md) 第 5 節（已定案的事）。

---

## 先講結論：七條需求裡有兩條現在就能做

把需求逐條對到現況，v2 的範圍其實比看起來小。

| #   | 需求                         | 現況                      |
| --- | ---------------------------- | ------------------------- |
| 3   | COST 最小單位 0.01           | ✅ **v1 已經支援**        |
| 7   | 夾擠式罰 C（差 7 +1、8 +2…） | ✅ **v1 已經支援**        |
| 5   | 布勞按隊友稀有度加 C         | 需要 v2：卡片屬性修正     |
| 6   | 魯卡按隊伍總血量加 C         | 需要 v2：隊伍聚合修正     |
| 2a  | COST 越大，壓 C 範圍越寬     | 需要 v2：容許曲線         |
| 2b  | 諾伊 + 卡爾杜斯才 +C         | 需要 v2：組合協同         |
| 1   | 主 C／輔助的相對位置修正     | 需要 v2：標籤 + 相對位置  |
| 4   | 全體勝率 50%                 | ❌ **這不是規則**，見最後 |

### #3 已經做完了

`cost-number.ts` 的精度就是 0.01，而且引擎內部一律用整數百分之一運算
（`8.8 + 26.6 + 26.6` 用 double 是 `62.00000000000001`）。不必等 v2。

### #7 只是多幾個 band，不用改 schema

夾擠式罰 C 寫成 `gap-band-v1` 就好，`bands` 上限是 32 個，夠用：

```json
{
  "type": "gap-band-v1",
  "bands": [
    { "minGap": 7, "maxGap": 7, "extraCost": 1 },
    { "minGap": 8, "maxGap": 8, "extraCost": 2 },
    { "minGap": 9, "maxGap": 9, "extraCost": 3 },
    { "minGap": 10, "maxGap": 11, "extraCost": 4 },
    { "minGap": 12, "maxGap": 13, "extraCost": 5 },
    { "minGap": 14, "maxGap": 14, "extraCost": 6 },
    { "minGap": 15, "maxGap": 15, "extraCost": 7 }
  ]
}
```

`validate.ts` 已經會擋區間重疊與多個無上界，`calculateTeamCost` 也已經
逐對套用。**這條今天就能發布成一份規則試玩**，不用等 v2 —— 建議先這樣做，
拿真實回饋再決定要不要往下走。

---

## v2 的形狀：資料與規則分層

v1 的 `characters` 是 `{ 鍵: 數字 }`。v2 讓它可以帶屬性：

```jsonc
{
  "characters": {
    "cc078_r03": { "baseCost": 22, "tags": ["support"] },
    "cc003_r03": { "baseCost": 18, "tags": ["main-dps"] },
    "cc012_04": 14, // 純數字仍然合法
  },
}
```

純數字要繼續收 —— 700 張卡裡絕大多數不需要任何標籤，逼所有人寫成物件只會
讓規則檔膨脹十倍且更難 diff。

標籤是**自由字串**，引擎不知道 `"support"` 在人類語義上是什麼，它只會做
`tags.includes(x)` 的比對。這樣「什麼算輔助」是規則作者的主張，不是我們寫死的
判斷 —— 兩個作者可以對同一角色有不同分類，各自發布。

規則本體另外放：

```jsonc
{
  "adjustments": [{ "type": "…", "…": "…" }],
}
```

`type` 是**白名單列舉**，跟 v1 的 `compressionRule.type` 一樣。§12 硬規則：
規則內容只能驅動既有的計算分支，不得轉譯成 `eval` / `Function` / 動態載入。
所以永遠不會有「條件式字串」這種欄位。

> ⚠ 不要開放玩家上傳 JS／Lua。除了惡意程式碼，更麻煩的是版本重現性、
> 執行時間上限、無窮迴圈，以及 Companion 與網站兩邊結果必須一致。
> v1 已經刻意把 `restrictions.condition` 定成「永遠不解析的人類文字」，
> 這條邊界要守住。

---

## 五種調整原語

每一種都直接對應到上面某一條需求。

### 1. `card-property` —— 依卡片屬性（#5 布勞）

```jsonc
{
  "type": "card-property",
  "target": "cc0XX_r03", // 只有這張卡吃這條
  "source": "teammates", // self | teammates | team
  "property": "rarity",
  "weights": { "3": 0, "4": 0.25, "5": 0.5, "10": 1 },
  "aggregate": "sum", // sum | max | min | count
}
```

隊友是 R4 + R3 → 布勞 `baseCost + 1 + 0.5`。

`property` 也是白名單（`rarity` / `level` / `hp` / `atk` / `def`），值都從
`cc_asset` 讀得到，Companion 本來就有（`readCharacterAssets()`）。

### 2. `team-aggregate` —— 依隊伍總量（#6 魯卡）

```jsonc
{
  "type": "team-aggregate",
  "target": "cc0YY_r03",
  "property": "hp",
  "source": "team",
  "curve": [
    { "min": 0, "max": 29, "addCost": 0 },
    { "min": 30, "max": 34, "addCost": 0.5 },
    { "min": 35, "addCost": 1.5 },
  ],
}
```

跟 `GapBand` 同一個形狀（分段函數、不得重疊、最多一個無上界），驗證邏輯
可以直接沿用 `gapBandIssues`。

**初版只允許分段函數，不要開放任意數學式** —— 分段函數可以窮舉驗證，
而且跨語言（TypeScript／PHP）算出來一定一樣。

### 3. `combination` —— 組合協同（#2b 諾伊 + 卡爾杜斯）

```jsonc
{
  "type": "combination",
  "when": { "containsAll": ["cc0NN", "cc0KK"] }, // 角色代號，不含等級
  "effects": [{ "target": "cc0NN", "addCost": 0.75 }],
}
```

`containsAll` 比對的是角色代號（`cc078`）而不是卡片鍵（`cc078_r03`），
這樣「不管幾等的諾伊配上不管幾等的卡爾杜斯」都吃得到，作者不必列 100 組。

需要區分等級時再寫完整的卡片鍵。兩種都收，靠字串長度分辨太脆弱 ——
應該用兩個欄位 `containsAllCharas` / `containsAllCards` 明確分開。

### 4. `relative-position` —— 主 C／輔助（#1）

```jsonc
{
  "type": "relative-position",
  "targetTag": "support",
  "highest": { "whenGapSumAtLeast": 8.01, "addCost": -1 },
  "lowest": { "addCost": 1 },
}
```

`gapSum` 定義為 `Σ |target.cost − teammate.cost|`。R3 利恩 `22 / 17 / 17`：

```
(22−17) + (22−17) = 10  ≥ 8.01  →  利恩 22 → 21
```

主 C 就是把方向反過來（`highest.addCost` 為正、`lowest` 為負），不需要新的
`type`。

> ⚠ 原始需求寫「大於 8」。邊界要寫死成 `whenGapSumAtLeast`（≥）還是
> `GreaterThan`（>）必須二選一並固定，不能兩種都支援 —— 這正是
> [official-cost-rule.md](official-cost-rule.md) 裡官方 `>= 7` 那種邊界，
> 差一個等號就是不同規則。

### 5. `compression-tolerance` —— 壓 C 範圍隨 COST 放寬（#2a）

```jsonc
{
  "type": "compression-tolerance",
  "basedOn": "maxCost", // maxCost | minCost | teamCost
  "bands": [
    { "minCost": 30, "freeGap": 7 },
    { "minCost": 25, "freeGap": 6 },
    { "minCost": 20, "freeGap": 5 },
  ],
}
```

`30 / 23 / 23` → `maxCost = 30` → `freeGap = 7` → 差 7 不罰。

實作上是在跑 `gap-band-v1` **之前**先把 `freeGap` 以內的配對剔除，而不是去改
band 表。這樣壓 C 那段程式碼不用動，也不會出現「兩份 band 打架」的狀況。

---

## 計算順序必須固定分層

這是整個 v2 最重要的一條，也是最容易被忽略的。

考慮：諾伊 + 卡爾杜斯 → 諾伊 +1 → 諾伊變成全隊最高 → 主 C 的「最高時 +C」
要不要跟著觸發？如果規則可以互相重新觸發，就會產生非分層遞迴，甚至：

```
A +1 → 變最高 → 再 +1 → 壓 C 結果改變 → 又影響別人 → …
```

`relative-position` 更直接地暴露了這件事：利恩 `22 → 21` 之後 gapSum 從 10
變成 8，**條件自己失效了**。要是允許重算，結果就取決於你算幾輪。

所以 v2 採**固定階段**，同一階段內不得回頭觸發前面的階段：

```
  ① 基礎 baseCost
        ↓
  ② card-property / team-aggregate      （布勞、魯卡）
        ↓
  ③ combination                          （諾伊 + 卡爾杜斯）
        ↓
  ④ relative-position                    （主 C／輔助，讀 ③ 的結果）
        ↓
  ⑤ compression-tolerance → gap-band     （壓 C，讀 ④ 的結果）
        ↓
  ⑥ 總和
```

每一階段的輸入是上一階段的輸出，跑完就固定。這讓每份規則都是
**必然終止且確定性**的，不需要不動點迭代，也不會有「算兩次不一樣」。

同一階段內有多條規則時，按**規則檔裡的陣列順序**套用，並且禁止同一階段內
兩條規則寫同一個 target —— 後者應該在 `validate.ts` 擋掉，因為那是作者
把兩條規則寫成互相覆蓋，幾乎一定是失誤。

---

## 明細追溯是必要功能，不是加分項

一旦允許自訂規則，兩個玩家很快就會遇到「為什麼我算 61.25、你算 62.25」。
沒有明細就查不出是哪條規則造成的。

`CostCalculation` 已經有 `items` 與 `compression`（逐對列出 `a`/`b`/`gap`/
`extraCost`）。v2 要把它擴成每一階段都留痕：

```
利恩 R3                  22.00
  輔助・最高 C 修正       −1.00
                         ──────
                          21.00

布勞 R3                  18.00
  隊友 R4 稀有度          +1.00
  隊友 R3 稀有度          +0.50
                         ──────
                          19.50

諾伊 R3                  20.00
  卡爾杜斯協同            +0.75
                         ──────
                          20.75

壓 C（容許 7 以內）        +0.00
                         ══════
隊伍總 COST               61.25
```

原版 UI 在這件事上是**壞的** —— 遊戲的 `+5` 標記會貼在錯的卡底下（見
official-cost-rule.md）。所以這不只是補足，是我們比原版強的地方。

---

## #4「全體勝率 50%」不是規則，是最佳化目標

這條必須從 DSL 裡拿掉，理由是它會直接摧毀 contentHash 制度：

> 如果「目前勝率 55% → 自動 +0.37C」寫進規則，那**同一個 contentHash 今天和
> 明天會算出不同結果**。整套「Canonical JSON → SHA-256 → 不可變版本」就沒有
> 意義了，兩個玩家也不再算得出同一個數字。

正確的位置是規則**之外**的離線迴圈：

```
規則 vN → 對戰 → 戰績 → 統計模型 → 估計各組合勝率
                                        ↓
                              Optimizer 建議調整
                                        ↓
                              人類審核並接受
                                        ↓
                       發布 vN+1（新的 contentHash）
```

而且要先承認一件事：**不可能讓所有隊伍都到 50%。** 存在對位效應、玩家強度
差異、選角偏誤與角色間的非加性交互作用。合理的目標函數是帶收縮項的最小化，
第二項用來避免 COST 每版劇烈震盪：

$$L(\theta)=\sum_i w_i\left(\hat p_i(\theta)-0.5\right)^2+\lambda\lVert\theta-\theta_0\rVert^2$$

這是校準問題，不是「勝率高就加 C」。實作上它是另一個服務，不進 Cost Engine。

---

## 「玩家會不會接受」—— 我的看法

你自己提的疑慮是對的方向，但風險點我認為不在「規則太多」。

**真正的風險是非局部性。** 規則 1（主 C／輔助）與 2a（容許曲線）讓
**一張卡的價格取決於隊友是誰**。這打破了玩家既有的心智模型 ——
「這張卡就是 22C」。玩家能接受一長串規則，但很難接受「我換一張別的卡，
原本那張卡的價格也變了」。#5 布勞、#6 魯卡也有同樣性質，只是幅度小。

相對地，#7 夾擠式罰 C 雖然條目最多，卻**完全不會有這個問題** ——
它是原版壓 C 的細化，玩家早就懂那個模型了。

所以我的建議是：

1. **先只發 #7。** 今天就做得到，不用等 v2，而且是最容易被接受的一條。
   拿它去試水溫，比在白板上猜玩家反應有用得多。
2. **非局部規則進來時，價格要在牌組畫面上即時顯示。** 玩家不需要能心算，
   但必須能**當場看到**：把卡拖進去就看到它變成 21.00 並附上原因。
   插件已經有能力改寫牌組畫面（`patch-cost` 走的就是那條路），這件事做得到。
3. **預設是模板，複雜度是選配。** 一般玩家 fork 官方模板改幾個數字；
   進階玩家才點「新增規則」看到 selector／condition／effect 的表單。
   不要讓第一次打開的人看到 AST。

至於「需要列出 cost 的原因清單」—— 那不是成本，那是這個功能的賣點。
上面那份明細就是它。
