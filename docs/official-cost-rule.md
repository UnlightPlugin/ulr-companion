# 原版 COST 規則

遊戲自己怎麼算隊伍 COST。**這份不是推測** —— 每一條都對得上客戶端本體的
原始碼，出處在最後一節。

自訂規則要能被信任，前提是先精確重現原版。玩家會拿自訂表跟他每天在玩的
數字比對，差一分錢就會被當成插件算錯。

---

## 一句話版本

> 隊伍 COST ＝ 三個槽位（角色**或怪物**）＋ 武器 ＋ 事件卡 ＋ 壓 C 罰則
>
> 壓 C 罰則 ＝ **隊內每一對槽位**各判一次：差距 7\~13 罰 5C，差距 14 以上罰 10C。

三個槽位就是三對，所以最多罰三次。

---

## 四張表，但不是四個平行的加項

一副牌組是四張表組合出來的，而它們**不對稱**：怪物卡跟角色卡共用同樣那三個
槽位，武器與事件卡才是獨立的加項。

| 卡種 | Phaser 快取鍵 | 陣列      | 筆數（2026-08-16） | 規則鍵                   | 參與壓 C |
| ---- | ------------- | --------- | ------------------ | ------------------------ | -------- |
| 角色 | `cc_asset`    | `.frames` | 781 格 / 700 張    | `filename`（`cc078_04`） | ✅       |
| 怪物 | `mc_asset`    | `.frames` | 139 格 / 138 張    | `filename`（`mc001_01`） | ✅       |
| 裝備 | `avatar_item` | `.weapon` | 238                | `wp` + 補零索引          | ❌       |
| 事件 | `event_info`  | `.frames` | 110                | `ev` + 補零索引          | ❌       |

怪物走角色那條路是**客戶端自己的分流**，不是我們的分類：

```js
Chara.getCharaType = function (chara, charaIndex) {
  if (chara.startsWith("cc")) return "chara"; // → cc_asset
  if (chara.startsWith("mc")) return Chara.isBoss(charaIndex) ? "boss" : "mons"; // → mc_asset
};
```

`costcheck()` 只呼叫 `Chara.getAsset(chara, charaIndex)`，兩種卡都被 push 進
同一個 `deckArray` —— 所以怪物照樣拉開差距、照樣罰 C。

> ⚠ 任何「只查 `cc_asset`」的程式碼碰到怪物牌組都會**安靜地算錯**：怪物的
> `charaIndex` 索引的是 `mc_asset`，拿去查 `cc_asset` 會撈到一張**存在但完全
> 不相干**的角色卡，而且不會報錯。

### 裝備與事件卡沒有名字

客戶端查它們就是純陣列索引：

```js
EventData.get = function (index) {
  return EventData.eventJSON.frames[index] ?? null;
};
AvatarItem.get = function (type, index) {
  return AvatarItem.itemJSON[type][index];
};
```

所以規則鍵只能從索引來（`wp001` / `ev091`，補零到 3 位）。索引之所以還算穩，
是因為它**同時是材質的 frame 名**：`event_info` 110 筆對上 `event_asset` 材質
110 格（`"0"`…`"109"`），`avatar_item.weapon[i].frame === i` 全部 238 筆一致。
官方要在中間插一張卡就得連美術圖集一起重編號。完整說明見
`packages/rule-schema/src/card-key.ts`。

### 首領怪物不在裡面

`Chara.isBoss(charaIndex)` 是 `charaIndex >= 20000`，走的是 `mc_boss`。那是 raid
的怪，玩家的牌組放不進去，所以規則沒有這張表。

---

## 牌組物件長什麼樣

2026-08-16 從跑著的客戶端（`Edit.deck1`）直接讀到的：

```js
{
  chara:      ["cc009", "cc006", "cc018"],   // 怪物是 "mc001_01"，前綴決定查哪份資產
  charaIndex: [83, 53, 175],                 // cc_asset 或 mc_asset 的 frames 索引
  weapon:     [null, null, null],            // 3 格，索引 avatar_item.weapon
  eventIndex: [null × 18],                   // 18 格，索引 event_info.frames
  cost:       49                             // 伺服器存的原版總和
}
```

---

## 壓 C 的精確定義

設隊伍裡**實際有卡**的角色 COST 為集合 $S$，對每一個無序配對
$\{x, y\} \subseteq S$：

| $\lvert x - y \rvert$ | 追加 |
| --------------------- | ---- |
| 0 \~ 6                | 0    |
| 7 \~ 13               | +5   |
| 14 以上               | +10  |

全部加起來就是這副牌組的罰則。**沒有第三級** —— 差 82 跟差 14 一樣是 10C。

### 五個對照例子

前三筆是 2026-08-15 在網頁版牌組畫面上直接截到的，後兩筆是燈皇給的。

| 牌組           | 配對差距              | 罰則             | 總 COST |
| -------------- | --------------------- | ---------------- | ------- |
| `15 / 13 / 20` | 2、5、**7**           | 5                | 53      |
| `9 / 13 / 20`  | 4、**7**、**11**      | 5 + 5 = 10       | 52      |
| `17 / 17 / 99` | 0、**82**、**82**     | 10 + 10 = 20     | 153     |
| `24 / 8 / 8`   | 0、**16**、**16**     | 10 + 10 = 20     | 60      |
| `30 / 8 / 15`  | **7**、**15**、**22** | 5 + 10 + 10 = 25 | 78      |

`packages/cost-engine/test/official-rule.test.ts` 把這五筆都當成測試案例。

### 三件容易搞錯的事

**1. 武器與事件卡計入總和，但不參與壓 C。** 官方的 `deckArray` 只 push 三個
**槽位**的 COST。武器再貴也不會拉開差距 —— 但**怪物卡會**，它佔的就是角色的
位子（見上面「四張表」那一節）。

**2. 兩人隊伍也會罰。** 只有一對，判一次。單人隊伍沒有配對，罰 0。

**3. 查不到價格的卡算 99。** 客戶端的 `UNKNOWN_COST = 99`，而且**這個 99 會
照常參與壓 C**。上表第三筆的 99 就是這樣來的 —— 它跟兩張 17 各差 82，於是各
罰 10。引擎跟著這樣做（`@ulr/cost-engine` 的 `UNKNOWN_COST`），並把該 ID 列進
`unknownIds`，總和才會跟玩家畫面上看到的一致。

> ⚠ 不能改成當 0。那會讓「規則漏寫了某張卡」的超標隊伍看起來合法。

---

## ⚠ 遊戲畫面上的罰 C 標記會貼錯卡

牌組畫面每個角色下面會顯示 `+5` / `+10`。**那個位置不代表是這張卡造成的。**

原因在客戶端自己的程式碼裡：`cost_text[i]` 讀的是 `result.cards[i]`
（**槽位順序**），但 `cost_penalty_text[i]` 讀的是 `result.penalties[i]`
（**排序後的順序**）。兩個索引空間不同，遊戲沒有做對應。

最明顯的例子是上表第一筆：

```
牌組  15  13  20
差距  只有 13↔20 的 7 超標
畫面  15 +5    13      20        ← +5 貼在 15 底下
```

罰則明明來自 13 與 20，標記卻出現在 15 底下。

**所以插件不應該照抄這個顯示。** `calculateTeamCost` 回傳的 `compression`
是逐對列出的（`{ a, b, gap, extraCost }`，`a`/`b` 是 `members` 的索引），
要做「為什麼罰我 5C」的明細就用它。這也是自訂規則能贏過原版 UI 的地方之一。

### 插件怎麼貼（2026-08-16 起）

`patch-penalty.ts` 蓋掉徽章時**把每一對的罰則貼在這一對裡比較便宜的那張卡
底下**（一樣貴貼前面那格，一張卡踩到兩對就相加）。理由是壓 C 罰的正是「為了
湊上限而被夾帶進來的低 C 卡」—— 那張才是玩家要換掉的。三格的和仍然等於總罰則。

> ⚠ 這支原本照抄了原版的擺法（把命中的罰則由大到小填進 0、1、2 格）。
> 實測 `19 / 13 / 22` 配夾擠式規則：罰則來自 13↔22，`+3` 卻貼在 19 底下 ——
> 而「第一格是誰」純粹看玩家怎麼排牌組。圍欄在
> `packages/cdp-adapter/test/patch-penalty.test.ts` 的「罰則貼在造成它的那張卡上」。

---

## 上限不在規則裡

原版規則包的 `teamCostLimit` 是 **0＝不設限**。

客戶端裡**沒有任何 COST 上限常數**（`costLimit`、`maxCost` 之類全部搜不到）。
上限是伺服器按頻道下發的 —— `Match` 場景收到的 `on_server_status` 帶著
`channels[3] = { type: "ranked", cost: [null, null, null] }`，那三格才是上限，
而且官方 news 有「コスト制限更新」的紀錄，代表它會被改。

所以「上限」是**對戰環境**的屬性，不是 COST 規則的屬性。規則只定義價格與壓 C。

---

## 出處

全部來自 2026-08-15 對跑著的網頁版客戶端（`:9334`）做的 CDP 探測。

| 東西             | 位置                                                         |
| ---------------- | ------------------------------------------------------------ |
| 壓 C 與總和      | `src/deck/cost-check.ts` 的 `costcheck()`                    |
| 牌庫上的警告圖示 | Edit 場景的 `refresh_penalty_info()`                         |
| 罰 C 文字怎麼填  | `refresh_penalties()`，`new Deck(d).getCost()` → `costcheck` |
| 角色卡資料       | Phaser 快取的 `cc_asset`，`Chara.getCharaAsset(charaIndex)`  |

客戶端 bundle 內嵌了**未壓縮的原始碼**（webpack `eval` + sourcesContent），
所以拿到的是帶註解與原始變數名的版本，不是反編譯的猜測。重挖的方法見
[.claude/skills/probe-game](../.claude/skills/probe-game/SKILL.md)。

### 原文（節錄，排版經 prettier 重排，內容未改）

```ts
var UNKNOWN_COST = 99;

function costcheck(deck) {
  var result = {
    total: 0,
    event: 0,
    weapon: 0,
    cards: [null, null, null],
    penalties: [null, null, null],
  };
  var deckArray = [];
  for (var n = 0; n < 3; n++) {
    // …略：空槽 continue…
    var asset = chara_1.Chara.getAsset(chara, charaIndex);
    var cost = asset?.cost ?? UNKNOWN_COST;
    result.cards[n] = cost;
    deckArray.push(cost);
  }
  deckArray.sort(function (a, b) {
    return a - b;
  });
  // this could probably be done iteratively
  switch (deckArray.length) {
    case 2: {
      /* d1-d0 >= 14 → 10；>= 7 → 5 */
    }
    case 3: {
      /* 見下方說明 */
    }
  }
  // …event / weapon 加總…
  // total = event + weapon + Σcards + Σpenalties
}
```

`case 3` 是一段四層巢狀、把結果寫進不同 `penalties[i]` 的分支（原作者自己
留了 `// this could probably be done iteratively`）。它看起來像在做特殊判斷，
**但其實不是**。

設排序後 $a \le b \le c$，逐一展開四條路徑：

| 條件                                     | 官方寫進的格子               | 等於哪些配對     |
| ---------------------------------------- | ---------------------------- | ---------------- |
| $c-b < 7$，且 $c-a \ge 7$ 且 $b-a \ge 7$ | `[2]=f(c-a)`、`[1]=f(b-a)`   | $ac$、$ab$       |
| $c-b < 7$，其餘                          | `[0]` 被寫兩次，只有一次成立 | $ac$（或無）     |
| $c-b \ge 7$，$b-a < 7$                   | `[0]=f(c-a)`、`[1]=f(c-b)`   | $ac$、$bc$       |
| $c-b \ge 7$，$b-a \ge 7$                 | 三格都寫                     | $ab$、$ac$、$bc$ |

每一條路徑寫進去的，**剛好就是所有差距 $\ge 7$ 的配對**。那堆分支只是在
決定「這個 `+5` 要顯示在哪一格」，對總和沒有影響。

這不是靠讀懂它證明的 —— `official-rule.test.ts` 把上面那段官方分支**原封不動
移植**成對照組，然後窮舉 0\~40 的所有三元組（以及 0\~60 的所有二元組）比對
總和，全部相同。遊戲改版動了規則時，那個測試會直接紅掉。

---

## 原版 COST 表

`rules/unlight-official-2026.08.ulrcost.json`。

`official-rule` **四張表一次讀完**（2026-08-16 起）：角色 700、怪物 138、
裝備 238、事件卡 110，共 1186 筆。少讀一張表就等於那一種卡在規則裡全部缺席，
而缺席的卡會被算成 99C。

鍵：角色與怪物用資產的 `filename`（`cc078_04` = L4、`cc078_r04` = R4、
`mc001_01`），裝備與事件卡用 `wp` / `ev` 加補零到 3 位的陣列索引。
理由見 [open-questions.md](open-questions.md) 第 1 題。

### 重新產生

遊戲改版後要重跑：

```powershell
npx tsx apps/companion/src/index.ts official-rule --port 59223 `
  --out rules/unlight-official-2026.09.ulrcost.json --game-version 2026.09
```

⚠ **要在沒有套過自訂 COST 的客戶端上跑。** `patch-cost` 是就地改寫
Phaser 快取裡的同一份資料，對著套過的客戶端讀會讀回被改過的數字。指令會在
看到 cost 剛好是 99 的卡時提醒你，但那只是提醒，擋不住。

### 已知的資料形狀

**角色（2026-08-15）**

- `cc_asset.frames` 共 **781** 格，其中 **700** 格是卡
- 空位 **81** 格：索引 690–769 連續 80 格，加上索引 780 一個全欄位歸零的哨兵
- COST 範圍 8 \~ 38，**沒有任何一張是 99**
- 與 `E:\unlight_crawler\steam\data\cost_cc_pure.csv` 逐格比對 **700/700 全等**

最後一條同時證明了三件事：客戶端沒被改過、crawler 的快照還沒過期、
匯出流程沒有轉換錯誤。

**另外三張（2026-08-16）**

- `mc_asset.frames` 共 **139** 格，**138** 張是卡（索引 138 是空位）
- ⚠ `mc073_01` / `mc073_02` / `mc073_03` 的 cost **真的是 99**。那是資料裡就
  這樣，不是客戶端被改過 —— 匯出時的 99 警告會點名它們，看到這三張是正常的
- ⚠ 怪物的 `chara` 欄位**等於 `filename`**（139/139 全等），不像角色那樣是
  去掉等級的形式。要分辨卡種請看前綴，不要看這兩欄相不相等
- `avatar_item.weapon` **238** 件，`frame === 陣列索引` 全部一致
- `event_info.frames` **110** 張，沒有任何一筆有 `filename`
- 與 `cost_weapon.csv` / `cost_event.csv` 的 `idx` 欄對得上（抽查 wp000/001/002、ev003）

---

## 自訂：在托盤裡改（推薦）

托盤的 **牌組 › 編輯 COST** 是給玩家用的那條路。它解決的是一件事：
規則檔裡是 `cc001_01`，而**沒有人知道那是誰**。

四個分頁，每一格顯示的都是卡片名稱：

| 分頁   | 版面                                 | 筆數（2026-08-16） |
| ------ | ------------------------------------ | ------------------ |
| 角色卡 | 一位一排，`L1~L5 R1~R5` 十格         | 70 位 / 700 張     |
| 事件卡 | 九張一排，照客戶端的族群分塊         | 110 張 / 8 族      |
| 裝備卡 | 照「這是誰的專武」分組，通用排最前面 | 238 件 / 70 組     |
| 怪物卡 | `M1~M3`，一排放三種怪物              | 46 種 / 138 張     |

中間那份「編號 → 名稱」的對照叫**名冊**，從玩家自己跑著的客戶端讀
（`charaProfile` / `monsProfile` / 兩份資產的 `name_tcn`），存在
`~/.ulr-companion/catalog.json` 重複使用 —— 讀過一次之後，沒開遊戲也能改表。

```powershell
# 托盤裡有按鈕，這是不開 GUI 時的等價指令
npx tsx apps/companion/src/index.ts catalog --port 59223
```

事件卡那一頁除了名字還帶**插槽顏色**（左邊的色帶）與**效果說明**。兩個都不是
裝飾：

- **顏色**決定這張卡放得進哪一格 —— 一張事件卡只放得進角色卡上同色的事件插槽，
  灰色（資料裡的 `type === 7`，客戶端叫 `EventCardType.ANY`）是萬用。所以顏色
  跟價格是同一件事的兩面：紅卡再便宜，紅槽少的角色也帶不動。
  ⚠ **看名字推不出來** —— 「劍3·盾3卡」是紅的，「劍5·槍5卡」卻是萬用。
- **效果**是因為名字會撞：110 張裡有五張全叫「Hp恢復」（`ev088`~`ev093`），
  一張回 1 點、一張回 3 點，還分屬三種顏色。名字說得出效果的那 90 張
  （「此卡當作劍4使用」）不會印這一行，免得真正要讀的那 20 張被淹掉。

色票是量客戶端自己的 `event_slot` 貼圖來的：紅=劍、綠=槍、藍=防禦、紫=移動、
黃=特殊、白=機會、黑=詛咒、灰=萬用。

⚠ **要在沒套過自訂 COST 的客戶端上讀。** 名冊裡的「原價」是編輯器「改回原價」
的基準，對著套過的客戶端讀會讀到改過的數字 —— 於是玩家按下去會改回一個他從來
沒設過的值。托盤會擋（`cost.phase === "applied"` 時不給讀）並告訴你怎麼救。

存檔是**就地覆寫同一個檔**，不會多生一份（`unpack` 的產物留在同一個資料夾裡，
造成過「同一份規則有兩個檔」的困惑）。核對碼每次重算；版本號要不要動由作者
自己決定，介面上就是一格可以改的欄位。

> ⚠ 介面把「**未存檔**」與「**跟原版不同**」分成兩個數字，那不是囉唆：
> 一份自訂規則本來就有一堆格子跟原價不同，用後者當存檔鈕的條件的話，存完檔
> 按鈕還亮著、上面還寫著「改動 4 格」，玩家會一直以為有東西沒存。

---

## 自訂：直接改檔案

**直接複製一份規則包來改也可以。** `contentHash` 是從內容算出來的衍生值，
載入與 `pack` 都會重算，所以改完不必做任何額外動作：

```powershell
copy rules\unlight-official-2026.08.ulrcost.json my.ulrcost.json
#   改 my.ulrcost.json 的 characters / monsters / equipment / eventCards /
#   compressionRule / ruleSetId / publisher
#   （contentHash 那一欄不用管，載入時會重算）
npx tsx apps/companion/src/index.ts rule my.ulrcost.json   # 看重算後的 8 碼
```

`unpack` 仍然在，但**不再是改 COST 的必要步驟** —— 裸規則少一層信封，
純粹是比較好讀、diff 比較乾淨而已。要把檔案傳給對手之前跑一次 `pack`，
檔案裡的 `contentHash` 就會跟內容對上（不跑也能用，只是檔案裡那欄是舊的）。

前 8 碼**就是跟對手核對用的東西**，兩邊一樣才代表算的是同一份規則。而它
既然是從內容重算的，改過的規則自然拿到自己的碼 —— 不會出現「頂著原版的碼、
數字卻不一樣」這種情況（配對鍵用的也是這個值，見
`packages/arbiter-link/src/match-queue.ts` 的 `matchCriteria`）。

> ⚠ 例外：未來 ULGG 發布的、帶簽章的規則包不重算 Hash —— 那時候 Hash 是
> 簽章蓋住的東西。對不上就是拒絕載入，請跟發布者要完整檔案。

套到遊戲上有兩條路：

| 方式   | 怎麼做                                                 |
| ------ | ------------------------------------------------------ |
| 命令列 | `companion cost my.ulrcost.json --port 59223 --reload` |
| 托盤   | `牌組 › Cost 表` → 選規則檔 → 重載遊戲                 |

⚠ **注入只對之後載入的 document 生效**（`addScriptToEvaluateOnNewDocument`）。
選好規則之後畫面上的數字不會立刻變，那是正常的，要重載遊戲。托盤的狀態列
會顯示 `已裝上，等遊戲重新載入才會變`。

⚠ **換規則時舊的注入一定要先拆掉。** `addScriptToEvaluateOnNewDocument` 是
累加的，而 `patch-cost` 的 `__ulrCostPatch` 閘只讓**第一支**跑成功 —— 不拆
就直接裝新的，下次載入生效的會是**舊規則**，而且完全沒有錯誤訊息。
引擎在 `#syncCosts()` 裡處理了這件事；直接用 CLI 連續套兩份則會踩到，
要換規則請先關掉遊戲分頁重開。

---

## 自訂壓 C 罰則：客戶端是寫死的

⚠ **改規則的 `compressionRule` 不會自動反映到遊戲畫面。** 卡片價格住在
`cc_asset` 這份**資料**裡（所以 `patch-cost` 改得動），但罰則的門檻
（7 → +5、14 → +10）是寫死在 `costcheck()` 的**程式碼**裡的。

`packages/cdp-adapter/src/patch-penalty.ts` 補上這一塊，一共要攔三個地方 ——
少任何一個，玩家看到的就是不一致的畫面：

| 攔哪裡                     | 修好什麼                                       |
| -------------------------- | ---------------------------------------------- |
| `Deck.prototype.getCost`   | 牌組畫面的**總和**                             |
| `refresh_penalties`        | 每張卡底下的 **`+N` 徽章**                     |
| `WSClient.prototype.fetch` | 對戰大廳／任務畫面的 `cost:`（讀伺服器存的值） |
| `WSClient.prototype.emit`  | **把存檔送出去的 cost 還原成原版**             |

### 為什麼徽章要另外攔

遊戲畫徽章的是一個只認得兩個值的 switch：

```js
switch (s.penalties[i]) {
  case 10:
    setText("+10");
    break;
  case 5:
    setText("+5");
    break;
  default:
    setText(""); // ← 自訂的 +1 / +3 / +22 全掉進這裡
}
```

總和會吃我們的值，但徽章會是**空白**。實測 `15/13/20` 配夾擠式規則：
總和正確變成 49，三個徽章卻全是空的。

### 為什麼大廳要攔 fetch

`Match`／MatchingLobby／`Quest` 顯示的 `cost:53` 讀的是 `db_deck{n}` **回應裡的
`e.cost`**，也就是伺服器存的值 —— 那些場景自己不重算。所以只攔 `getCost`
的話，牌組畫面顯示 49、大廳仍然顯示 53。

⚠ 那個值是**進場時抓的**，換規則之後要離開再進去一次才會重抓。

### ⚠⚠ 為什麼一定要攔 emit（§12 硬規則 4）

牌組存檔送的是**整個 deck 物件、含 `cost`**：

```js
socket.emit("db_editdeck", this.id, this.deck1, this.deck2, this.deck3, checked);
```

而 `refresh_penalties` 會把算好的 total 寫回 `deck.cost`。**不攔的話，我們算
出來的數字就會被送上伺服器。**

> 「伺服器應該會自己重算」不是可以依賴的理由 —— 要驗證它就等於嘗試作弊。
> 規格書 §12 硬規則 4 明訂不得改變伺服器判定，所以正確做法是**根本不送**。

出站攔截一律用**原始** `getCost` 重算，封包與沒裝插件時逐位元相同。
⚠ 還原時要淺拷貝，不能就地改 —— 就地改會讓畫面上的數字在存檔那一瞬間跳回
原版，而且那個物件是場景還在用的同一份。

> 這條同樣適用於既有的 `patch-cost`：改了 `cc_asset` 的價格之後，
> `deck.cost` 也會跟著變。出站攔截把兩者一起蓋掉了。

### ⚠ webpack chunk id 不能重複用

拿 `__webpack_require__` 的方法是往 chunk 陣列推一個空 chunk。webpack 5 的
callback 是：

```js
if (chunkIds.some((id) => installedChunks[id] !== 0)) {
  if (runtime) var result = runtime(__webpack_require__); // ← 只在這裡
}
```

**推第二次同一個 id 時 `installedChunks[id]` 已經是 `0`，整個 runtime 回呼
被跳過** —— 拿不到 require，而且不拋錯。症狀是「第一次套規則正常，第二次
換規則靜靜地什麼都沒發生」，輪詢到逾時為止。所以 id 必須每次遞增。
