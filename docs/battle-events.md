# 戰鬥事件目錄（2026-08-02 雙邊實測）

WP-09 的產出。用 `companion watch` 同時接兩個客戶端，錄同一場對戰的 5 分鐘，
再把兩份 log 對起來。

```
網頁版 :9334（座位 A）   桌面版 :9333（座位 B）
```

**為什麼一定要雙邊錄**：單邊 log 沒辦法區分「這個事件是關於我的」還是「關於
對手的」。兩邊同時錄、比對次數，語意就自己浮出來了 —— 底下最重要的那條
（A/B 是座位不是敵我）就是這樣才看得出來，而單邊看了半年都會誤判。

擷取方式：`companion watch --port <N> --seconds 300`。
§12：只記事件名與參數形狀，不記值。

---

## 最重要的一條：**A/B 是座位，不是「我方/對手」**

| 事件           | A 位客戶端 出/收 | B 位客戶端 出/收 |
| -------------- | ---------------- | ---------------- |
| `card`（送出） | **53** / 0       | **39** / 0       |
| `cardclickedA` | 0 / **53**       | 0 / 51           |
| `cardclickedB` | 0 / **39**       | 0 / **39**       |

A 位送出 53 次 `card`，**兩個客戶端**都收到 `cardclickedA`；B 位送出 39 次，
兩邊都收到 `cardclickedB`。（51 vs 53 是桌面版晚兩秒才 attach。）

也就是說標籤在整場對戰是固定的：**A 永遠是同一位玩家，跟誰在看無關。**

> ⚠ 這推翻了 open-questions §4 的讀法。那份 log 只錄了一個客戶端，而它剛好
> 坐 A 位，所以「`okVisibleA` = 我方、`cardclickedB` = 對手」在那份樣本裡
> 成立 —— 但那是巧合，不是語意。
>
> 直接後果：`OPPONENT_ACTION_EVENTS = ["cardclickedB", "cardrotateB"]`
> 只對坐 A 位的人正確。坐 B 位的玩家跑起來，會把**自己的動作**判成
> 「對手動了」，移動階段仲裁的準備狀態每次都被自己取消。

### 客戶端怎麼知道自己坐哪一位

**直接讀 `game.scene.keys.MainA.PLAYER`。** 遊戲自己就是這樣做的
（2026-08-03 讀原始碼確認）：

```text
this.PLAYER = e.side, this.OPPONENT = "A" === e.side ? "B" : "A", this.isPlayerA = "A" === this.PLAYER
```

`e.side` 來自房間設定，也就是 `duel_standby` 的 `room_playerAinfo/Binfo`
那條資訊的下游。**這比從事件反推早，也比較不會錯。**

雙邊同時讀確認過（同一場對戰）：

```
:9334 網頁版  MainA.PLAYER = "A"      :9333 桌面版  MainA.PLAYER = "B"
```

備援：看你收到的是 `okVisibleA` 還是 `okVisibleB` —— 這類事件**只發給該座位
本人**（見下一節）。

⚠ **座位每場重新分配，而且真的會翻。** 2026-08-03 實測：同一個 :9334 客戶端
前後兩場分別是 `B` 與 `A`。任何「這場是 A 位」的快取都只在半數對局正確，
而錯的那半症狀是「對手動作不取消準備、自己動作反而取消」—— 完全不像座位問題。

⚠ 換房時 **socket 比 `MainA` 早一步換好**，所以偵測到 socket 換了的當下讀
`MainA.PLAYER`，可能還是上一場的 side。要持續校正，不能只讀一次。

---

## OK 狀態完全不外洩（比 §4 的結論更強）

| 事件         | A 位收到 | B 位收到 |
| ------------ | -------- | -------- |
| `okVisibleA` | **12**   | **0**    |
| `okVisibleB` | **0**    | **12**   |
| `I_am_ok`    | **0**    | **0**    |

兩件事同時成立：

1. **`I_am_ok` 只送不收。** A 位送 13 次、B 位送 12 次，兩邊收到 **0** 次。
   §4 的結論在雙邊樣本下再次確認，而且這次是兩個座位互相佐證。
2. **OK 鈕的可用狀態只發給本人。** A 位整場沒收到任何一次 `okVisibleB`。

> §4 記錄過「seat-A 的客戶端收到 3 次 `okVisibleB`」，並解釋成「反映階段與
> 凍結狀態」。這次 12 個階段一次都沒有。差異原因不明（協定改過？那 3 次來自
> 別的情境？），但**這次的樣本是雙邊同時錄的，可信度較高**。先記下分歧，
> 不改寫 §4 的原始記錄。

所以「對手沒裝插件時我方看不到對方 OK 狀態」是**協定保證**的，
不需要靠自律 —— 這條對 WP-12 的公平性論述是基石。

---

## 只有本人收得到的事件（座位私有）

推導方式：一邊有、另一邊完全沒有。

| 事件                              | 用途                           |
| --------------------------------- | ------------------------------ |
| `okVisibleA` / `okVisibleB`       | OK 鈕可用（座位偵測用這個）    |
| `cardController1A` / `1B`         | 手牌控制器啟用                 |
| `cardController2A` / `2B`         | 同上，第二階段                 |
| `defensePhaseA` / `defensePhaseB` | 輪到你防禦                     |
| `deleteDraw_A` / `deleteDraw_B`   | 棄牌                           |
| `additionalDraw_B`                | 追加抽牌（只在 B 位出現 1 次） |

---

## 雙方都收得到的事件

`cardclickedA/B`、`cardrotateA/B`、`chara_A/B`、`cardOpen_A/B`、`dmgToA/B`、
`healA/B`、`change_A/B`、`charachange_A/B`、`initiativeA/B`、`skill_effect_A/B`、
`diceRoll`、`distance`、`drawPhase`、`endDrawPhase`、`endMovePhase`、
`endDefensePhase`、`endPhase`、`endTurn`、`goToBochi`、`movepower`、
`passivebase`、`skillbase`、`state`、`timerReset`、`timerstop`、`atkvalue`、
`bonus`、`eventCard`、`msg_skill`

`phaselabel_A/B`、`playerAtkA/B`、`playerDefA/B` 兩邊都收得到，但**偏向自己
那一側**（A 位收 `playerDefA` 45 次、`playerDefB` 20 次；B 位剛好相反）。

---

## 送出側

| 事件          | A 位 | B 位 | 說明                                     |
| ------------- | ---- | ---- | ---------------------------------------- |
| `card`        | 53   | 39   | **出牌與收牌是同一個事件**               |
| `rotate`      | 17   | 17   | 轉牌                                     |
| `I_am_ok`     | 13   | 12   | 只送不收                                 |
| `move_select` | 3/3  | 7/7  | **唯一雙向的** —— 送出後自己也會收到一次 |
| `db_friend`   | 5    | 5    | 好友清單查詢                             |
| `changeReady` | 1    | 2    | 換角色就緒                               |

三個操作事件的參數形狀完全一樣：

```
card    str(32)  str(36)  num
rotate  str(32)  str(36)  num
```

- `str(32)` —— session token。**§12 不得記錄。**
- `str(36)` —— UUID。長度與 `db_friend` 送出的那個一致，**很可能是 match/room
  id**。若成立，WP-12 的 ulgg 就有現成的配對鍵（probe #4）。
  ⚠ **尚未證實** —— 要確認兩個客戶端送的是同一串，但目前的 shape-only 模式
  看不到值。做法見下面「還沒解的問題」。
- `num` —— 牌的索引。

### ✅ probe #2 已解：第一個 bool 就是出牌 / 收牌

2026-08-02 取值實測，同一張牌先出後收：

```
23.46s cardclickedA  41  true   false     ← 出牌
23.76s cardclickedA  42  true   false
24.55s cardclickedA  46  true   false
30.07s cardclickedA  41  false  false     ← 收牌（同一個 num）
30.54s cardclickedA  42  false  false
31.11s cardclickedA  46  false  false
```

**`cardclickedX(card_index, clicked, sound)`** —— 參數名不是猜的，是從遊戲自己的
程式碼讀出來的（見下面「直接讀遊戲原始碼」）：

```js
player_card_clicked(card_index, clicked, sound) {
    this._ulse06.play();
    if (sound === true) {
        this.time.addEvent({ delay: 100, callback: () => { this._ulse11.play(); } });
    }
```

- `clicked` —— `true` 出牌、`false` 收牌
- `sound` —— **只是要不要多播一個音效**，跟遊戲狀態完全無關

所以第二個布林永遠是 `false` 不是巧合：伺服器正常流程不會要求那個額外音效，
只有教學會明確傳 `true`。**這題再怎麼黑箱觀察都問不出來。**

### ⚠ `num` 是**牌的身分**，不是位置 —— 所以對手側不得取值

牌 41 的完整軌跡：

```
 1.24s cardrotateA  41            手牌轉牌
23.46s cardclickedA 41  true      出牌
28.13s cardrotateA  41            場上轉牌
30.07s cardclickedA 41  false     收牌
```

同一個 ID 從手牌到場上再回手牌都不變。**這證實 `num` 是卡片識別碼**，
而移動階段對手的牌是蓋著的 —— 所以 `cardclickedB` / `cardrotateB` 必須
維持排除在 `DEFAULT_VALUE_EVENTS` 之外。

（上面那組是**我方自己**的事件，自己的牌本來就看得見，取值不涉及隱藏資訊。
語意搞清楚之後，同一套理解就能套用到對手側，**不需要真的去記對手的 num**。）

### 手牌轉牌 vs 場上轉牌：事件分不出，但狀態分得出

伺服器**兩種都廣播**（玩家實測：看得到對手的手牌轉牌、收牌出牌、已出牌的轉牌），
而且事件名、形狀、數值範圍完全一樣：

```
 0.00s cardrotateA 43, 42, 41     ← 手牌轉（此時還沒出任何牌）
12.78s cardrotateA 43, 44, 45     ← 場上轉（43/44/45 剛在 10~12s 出掉）
```

**解法是自己維護「目前在場上的 num 集合」**：

```
cardclickedX(num, true)   → 加入
cardclickedX(num, false)  → 移出
cardrotateX(num)  num 在集合裡 → 場上轉牌（算操作）
                  num 不在集合 → 手牌轉牌（不算操作）
```

這個做法**完全不需要知道那張牌是什麼**，只是對不透明 ID 做狀態追蹤。
對手側同樣可行，而且推導出來的結論（「對手轉了場上的牌」）本來就顯示在
畫面上 —— 沒有用到任何隱藏資訊。

---

## 技能事件是**動態命名**的

```
cc052_sk01   cc052_sk02   cc052_sk03
cc052_sk04_player   cc052_sk04_opponent   cc061_sk03
```

名字裡帶角色代號（`cc052` = 這場用到的角色）。所以事件目錄**不可能是一份
固定清單** —— 任何「已知事件名」的白名單都會隨隊伍組成漏掉東西。牌譜要能
處理沒見過的事件名，不能靠列舉。

`_player` / `_opponent` 後綴值得注意：那是相對稱謂，跟 A/B 的絕對座位不同。

---

## 順帶解掉的：open-questions #1（角色 ID 用什麼）

```
chara_A  obj{chara_index,main,filename,chara,charaIndex,hp,hp_max,atk,def,level,weapon,known,…}
```

封包裡**同時**有 `filename`（`cc078_04` / `cc078_r04`，也就是 cc_asset 的鍵）
與 `chara` / `charaIndex` / `level`。

第 1 題糾結的「要不要在插件裡維護 charaIndex → filename 對照表」不存在 ——
伺服器直接給了 `filename`。也不必用 `chara + level`（那個分不出 L4/R4，
兩者 COST 不同）。

> 建議把 #1 標成已解，鍵定為 `filename`。決定權在維護者，所以這裡只提建議，
> 沒有直接改 open-questions.md。

---

## 移動階段的方向選擇（2026-08-02 取值實測）

四個選項全部是 `move_select` 的第三個參數：

| 畫面上的動作 | 送出的值   |
| ------------ | ---------- |
| 換角         | `"change"` |
| 前進         | `"front"`  |
| 後退         | `"back"`   |
| 待機（回血） | `"stay"`   |

### 取消選人 = **再送一次同一個值**

```
59.24s →送出 move_select  str(32) str(36) "stay"    →  ←收到 move_select "stay"
62.73s →送出 move_select  str(32) str(36) "stay"    →  ←收到 move_select null   ← 取消
64.58s →送出 move_select  str(32) str(36) "change"  →  ←收到 move_select "change"
66.79s →送出 move_select  str(32) str(36) "change"  →  ←收到 move_select null   ← 取消
```

是個 **toggle**：重送同一個選擇就取消，伺服器回 `null` 表示「現在沒有選擇」。
這也解釋了為什麼 `move_select` 是唯一雙向的事件 —— 回送的不是回音，是**結果
狀態**（選了什麼，或 null）。

### ⚠ 對手的移動選擇**不會**外洩

兩邊的 log 對照：每個客戶端收到的 `move_select` 次數與內容，都**只對應到
自己剛送出的那一次**，沒有任何一則是對方的。

這跟 `okVisible` 只發本人是同一類保證，而且直接關係到 WP-12：移動階段仲裁
可以放心做，因為插件在階段結束前一樣看不到對手選了什麼。

> 這也對移動規則 V1 提出一個沒被涵蓋的問題：**`move_select` 算不算「操作」？**
> V1 規則 2 只列了出牌、收牌、旋轉三種，但方向選擇同樣發生在移動階段，
> 而且同樣會改變結果。要不要讓它取消準備狀態，是還沒決定的事。

### 這道長度上限在這裡真的救了東西

```
→送出 move_select  str(32)  str(36)  "front"
                   ↑token   ↑room_id  ↑我們要的
```

同一則裡三個字串，兩個是機密、一個是要記的資料。靠 `VALUE_MAX_STRING_LENGTH`
（24）分開 —— 不是靠事件允許清單，清單只決定「這則事件要不要試著取值」。

---

## 移動階段的完整序列（含揭曉點）

```
→送出 move_select  str(32) str(36) "front"     ← 只回給自己，對手看不到
   … 雙方都選好 …
←收到 initiativeA                               ← ⚠ 先攻先宣告
←收到 movepower    -1  0  "front"  "change"     ← 2.00 秒後才揭曉數值與選擇
←收到 distance     1  false                     ← 新距離
```

### 狀態效果：`state` 事件帶著回合數

```
←收到 state  "mahi_2"  "A"  "B"
              ↑鍵_回合數  ↑誰中了  ↑誰施加的
```

第一個參數是 **`<state_info 的鍵>_<持續回合數>`** —— `mahi_2` 就是麻痺 2 回合。
後兩個是**絕對座位**（跟事件名的 A/B 同一套）。

⚠ 這是**施加時**的通知，不是每回合的剩餘量。要顯示「剩 1 回合」得自己從施加
時間往下數，或**直接讀畫面上的圖示數字** —— 後者跟 TIME 是同一個道理，遊戲
自己已經在維護那個數字了。

相關的還有：

```
←收到 skillbase    ["cc014_sk03,attack"]     ← "<角色技能>,<階段>"
←收到 passivebase  []  "A"                   ← 被動，第二個參數是座位
```

### 麻痺讓移動值歸零，先攻比的是**生效後**的值

玩家實測：被麻痺的一方出了 3 移動、沒麻痺的出了 1 移動，**沒麻痺的搶到先攻**。
`state_info` 對 `mahi` 的說明正是「移動值變為 0」。

所以先攻比的不是打出去的牌面，是套用狀態之後的實際移動值。

### ⚠ `initiativeX` 比 `movepower` 早 2 秒

一場對戰六組樣本，間隔全部是 **2.00 秒**，沒有例外：

```
121.97 initiativeB → 123.96 movepower 0 0 "stay" "stay"
171.84 initiativeA → 173.84 movepower -1 0 "front" "change"
471.07 initiativeA → 473.08 movepower -3 1 "front" "back"
561.57 initiativeB → 563.56 movepower 0 0 "change" "change"
603.72 initiativeA → 605.72 movepower 0 1 "stay" "back"
646.34 initiativeA → 648.34 movepower 0 0 "change" "change"
```

而且更早還有 `distance`：

```
256.07s distance 0 false
256.47s initiativeB          （+0.40s）
258.47s movepower 1 -2 "back" "front"   （+2.00s）
```

> **更正**：這份文件先前寫「`movepower` 是揭曉點、仲裁必須在它之前完成」，
> 後來又改成「`initiativeX` 才是，死線要往前推 2 秒」。兩個講法都失焦了 ——
> `distance` / `initiativeX` / `movepower` **全都在伺服器結算之後**，仲裁本來
> 就發生在那之前。真正重要的是**結算前什麼都不外洩**，而那件事已經驗證過了
> （`move_select` 只回給自己）。這三個事件的先後只影響牌譜要從哪一個開始
> 認定「這一輪結束了」—— 答案是 `distance`。

`movepower` 是絕對座位（兩個客戶端收到的值完全相同），跟 `cardclickedA/B`
同一個模式。

### `movepower` 的正負號 = 方向

| 樣本                       | A        | B        | 相加 |
| -------------------------- | -------- | -------- | ---- |
| `1  -2  "back"  "front"`   | back +1  | front −2 | −1   |
| `-1  0  "front"  "change"` | front −1 | change 0 | −1   |
| `-2  3  "front"  "back"`   | front −2 | back +3  | +1   |

**`front`（拉近）為負、`back`（拉遠）為正**，兩者**相加**就是距離變化量。
對得上玩家給的距離規則：差值 1 → 遠變中／中變近，差值 2 以上 → 遠變近，
近距離則維持（下限夾住）。距離本身是 0／1／2（近／中／遠）。

⚠ **但先攻仍然不是單純比絕對值大小。** `0 1 "stay" "back"` 那次 B 的絕對值
比較大，先攻卻是 A。加上麻痺那條（生效後的值才算），推測 `movepower` 報的
可能是**結算後**的位移而不是比較用的輸入。**先不要基於這兩個數字判斷先攻 ——
直接聽 `initiativeX`。**

### ✅ 移動值相同 → 隨機先攻

兩次**完全相同**的情況給出不同結果：

```
563.56 movepower 0 0 "change" "change"  →  initiativeB
648.34 movepower 0 0 "change" "change"  →  initiativeA
```

同樣的輸入、不同的先攻，證實了玩家說的「移動一樣隨機選一個」。

### ⚠ 但 `movepower` 的數字與先攻的關係**不是「大的贏」**

三個反例：

| movepower         | 誰數字大 | 先攻        |
| ----------------- | -------- | ----------- |
| `-1  0`           | B        | initiativeA |
| `-3  1`           | B        | initiativeA |
| `0   1`           | B        | initiativeA |
| `-2  3`（前一場） | B        | initiativeB |

所以那兩個數字**不是**用來比大小決定先攻的移動力，至少不是直接比。

一個沒驗證的解釋：`initiativeX` 既然先發，`movepower` 可能報的是**結算後**的
狀態（例如套用移動後剩下的點數），而不是比較用的輸入。

**先不要基於這兩個數字寫任何邏輯。** 要判斷先攻就直接聽 `initiativeX`ｰｰ
那個是伺服器明講的，不需要推。

---

## 倒數與凍結：**別用事件推剩餘秒數，讀畫面上的 TIME**

### OK 視窗確認是 31.0 秒

2026-08-02 讓移動階段跑到自然結束，取到**未受凍結干擾**的三次：

```
 6.00s → 37.07s = 31.07s
55.41s → 86.41s = 31.00s
262.17s → 293.21s = 31.04s      全距 0.07 秒
```

滿足「每階段 ≥3 次、全距 <1.5 秒」的標準，也跟 open-questions §4 早先量到的
31.0 一致。

### ⚠ 但 `okVisibleX` 不代表「新的 30 秒開始」

同一批樣本裡有一次只有 **26.15 秒** —— 那次的 `okVisibleA` 正好與
`timerResume` 同一瞬間。**凍結解除時 OK 鈕會重新啟用、再發一次 `okVisibleX`，
但倒數是接續的，不是重新計時。**

一場對戰 19 個區間裡 **15 個受凍結影響**，長度從 0.20 秒到 13.75 秒都有。
也就是說靠事件推剩餘秒數，多數情況都會算錯。

### 結論：讀 TIME 顯示，事件只拿來校準

畫面上那個 TIME 數字是遊戲自己維護的倒數，**凍結時它自己會停**，不需要我們
去追 `timerPause` / `timerResume` 做加減。

事件量到的 31.0 秒改當**校準值**：顯示 30 但伺服器 31 秒才收，那 1 秒就是
安全邊際的來源。

### ✅ TIME 的位置（2026-08-02 定位）

**當前 active 階段場景裡，位於 (380, 318) 的 `BitmapText`。**
380 正好是 760 寬畫布的水平中心。場景隨階段換 —— `MovePhaseA` /
`DefensePhaseA` / `AttackPhaseA` / `MainA`，所以要找目前 active 的那個，
不能寫死。

怎麼定位出來的：畫面上有 23 個數字（HP、手牌強度、回合數…），猜座標太脆弱。
改成**取樣兩次、找唯一在遞減的那個**：

```
DefensePhaseA | (380,318) | BitmapText | 24 → 22   （2.5 秒）
```

這個判準跟版面改版無關，也可以當自我驗證 —— 讀到的東西如果不會往下跑，
就是抓錯了。

連續讀 14 秒：

```
 0.0s  15      6.1s  9.2
 1.0s  14      7.1s  8.2
 2.0s  13      8.1s  7.1
 3.0s  12      9.1s  6.1
 4.1s  11     10.1s  5.1
 5.1s  10     11.2s  4.1
```

每秒 1 格，而且**低於 10 秒會變成一位小數** —— 正好在安全邊際最需要精度的
地方給了次秒解析度。解析要用 `parseFloat`。

### ⚠ 場景名的 A/B 跟事件名的 A/B **意思相反**

| 來源          | A/B 是什麼                             |
| ------------- | -------------------------------------- |
| WS 事件名     | **絕對座位** —— 兩個客戶端看到相同標籤 |
| Phaser 場景名 | **相對視角** —— 每個客戶端自己永遠是 A |

實測：**坐 B 位**的客戶端，倒數在 `MovePhaseA` 裡；坐 A 位的在 `DefensePhaseA`。
兩邊都是 `...A`。

這也是為什麼 `OK_BUTTON.scene = "MainA"` 對兩個座位都能用 —— UI 層一律以本地
玩家為 A。**但同一支程式裡混用兩套相反的慣例極容易出錯**，碰到 A/B 一定要先問
「這是事件名還是場景名」。

### 凍結由**消耗型卡牌**觸發

玩家提供，並由 38 則 `timerPause`／`timerResume` 佐證：

聖水、聖杯（＝聖水＋機會1）、機會1（抽 1 張）、機會3（抽 3 張）、詛咒卡、
重新洗牌 —— **打出去就消失的那些**。

---

## 換角的完整流程

```
←收到 change_A                              ← 伺服器：可以換了
→送出 changeReady  str(32)  2  str(36)      ← (token, 選第幾個, room_id)
←收到 charachange_A  obj{…}                 ← 新角色的完整資料
```

雙方同時換角時，`change_A` 與 `change_B` 同一時間到，`charachange_A` 與
`charachange_B` 也同一時間回。

只有對手換角時（我方是 A 位、對手換）只會看到 `change_B` → `charachange_B`，
**沒有 `changeReady`** —— 那是對手的客戶端送的。

`changeReady` 的第二個參數是**選了第幾個角色**（實測 1 與 2）。

---

## 擲骰：`1` 是正骰，`6` 是空骰

```
diceRoll obj{
  atkArr: [1,6,6,1,6,6,6,6,1,6,6,1,6,6,6,1,6,6,6,6],   ← 20 顆
  defArr: [6,1,1,1,1,6],                                ← 6 顆
  atkSuc: 5,
  defSuc: 4,
  cc054_sk01: 0,   ← 角色技能對骰的修正，鍵隨隊伍而變
  cc054_sk04: 0
}
```

骰面**只有 1 與 6 兩種值**，沒有 2~5。`atkSuc` / `defSuc` 是陣列裡 `1` 的個數
—— 一場完整對戰的 **14 組骰全部符合**，沒有例外。

⚠ **陣列不是累積的。** 七次投擲的攻擊骰長度是 20/25/25/23/25/15/26，內容彼此
不互相包含。（會想確認這件事是因為前兩筆剛好遞增，看起來像整場累加 ——
若真是累加，統計就會把同一顆骰重複計數。）

### 正骰率（一場對戰的樣本）

```
總骰數    205
正骰(=1)   63
正骰率    30.73%      （1/3 = 33.33%）
期望值    68.3 ± 6.7
偏離      −0.79σ
```

**與 1/3 相符，但還不足以證實。** 95% 信賴區間約 [24.4%, 37.0%]，區間裡同時
容得下 1/3 與 30%，一場對戰分不開它們。要把區間收到能區分的程度需要數千顆骰
—— 那是牌譜長期累積才做得到的事。

### 社群的「時段論」是可以驗的

玩家的說法：骰運看時段，爛骰時段正骰率低於 1/3、牌位分一直掉；好時段一直爆骰、
牌位往上。

這是個**可證偽的假設**，而且牌譜正好有驗它需要的全部東西：每次投擲的時間戳 +
完整骰面陣列。做法是把 `正骰率` 依時段分組，看組間差異有沒有超過二項分布的
自然波動。

**但要小心兩個陷阱**，否則一定會「驗出」不存在的效應：

1. **單場樣本的波動極大。** 上面那場 205 顆骰的 95% 區間寬達 12.6 個百分點。
   隨便挑兩場出來比，看起來「一場爛一場爆」是常態，不是證據。
2. **人在輸的時候比較會記得骰爛。** 分析必須用**事先定好的時段切法**跑全部
   資料，不能挑覺得爛的那幾場來算 —— 否則測到的是選樣，不是骰子。

先不預設立場。這件事值得做，因為無論結論是哪一邊，它都是社群長期爭論而
從來沒有資料的題目 —— 而這是插件少數能拿出硬證據的地方。

⚠ 物件裡的 `cc054_sk01` 這類鍵是**動態的**（角色代號 + 技能編號），
跟事件名一樣不能靠列舉。

---

## 傷害 = min(atkSuc − defSuc, 剩餘 HP)

```
dmgToA  1  10  11  true  false      atkSuc 5 − defSuc 4 = 1     11−1 = 10 ✓
dmgToA  5   5  11  true  false      atkSuc 6 − defSuc 1 = 5     10−5 = 5  ✓
dmgToA  1   0   9  true  false      atkSuc 12 − defSuc 1 = 11  ← 只扣到 1
```

參數是 `(實際扣血, 剩餘 HP, 最大 HP, ?, ?)`。一場對戰七次攻擊，**前六次
完全等於 `atkSuc − defSuc`**。

第七次差很多（預測 11、實際 1），原因是**那個角色只剩 1 HP** —— 記的是
實際扣掉的血量，不是理論傷害，所以會被剩餘 HP 截斷。下一行就是 `leaveRoom`，
戰鬥結束。

> 這條對牌譜很重要：**`dmgToX` 的第一個數字不能拿來反推攻防差**。要算
> 理論傷害得自己從 `diceRoll` 算，兩者在致命一擊時必然不同。

### ⚠ 上面的公式只適用於**戰鬥傷害**

玩家指出傷害分**直傷**與**戰鬥傷害**，而資料也對得上：一場對戰有
**9 次 `dmgToX` 但只有 7 次 `diceRoll`**。

多出來的兩次擠在 0.4 秒內：

```
301.71s ←收到 dmgToB  10  0  10  true   false
302.10s ←收到 dmgToA  10  0  10  false  true    ← 整場唯一不是 true false 的
```

兩邊同時歸零、前面沒有任何 `diceRoll` —— 這是自爆（`state_info` 的 `jikai`
＝自壞）造成的直傷。

**所以判斷直傷的可靠依據是「這次 `dmgToX` 前面沒有 `diceRoll`」**，不是那兩個
布林。布林目前只有這一個反例，光憑它命名不了欄位 —— 其餘八次全是 `true false`，
包含同一秒那次也是 `true false`。要定案得再收幾次直傷（自壞、毒、猛毒都算）。

牌譜的傷害模型因此要分兩類記，不能只存一個數字。

---

## 投降

```
→送出 match_surrender  str(36) str(32)     ← ⚠ 參數順序是 (room_id, token)
→送出 leaveRoom        str(32)
→送出 register         str(36)
→送出 __handshake_c    str(5) null
→送出 db_player        str(36)
   … 重新連上大廳，接著跑獎勵流程 …
```

> ⚠ **參數順序不一致。** `card` / `rotate` / `move_select` / `I_am_ok` 都是
> `(token, room_id, …)`，但 `match_surrender` 是 `(room_id, token)`。
> 任何「第一個參數是 token」的假設都會在這裡壞掉 —— 而且症狀會是把 room_id
> 當成 token 記下來，或反過來把 token 當成公開資料處理。

---

## 戰鬥結束、獎勵階段、升等

18 回合打滿之後的完整序列（2026-08-02 實測）：

```
→送出 db_bonusgame      str(36)
←收到 db_bonusgame      num num num arr(9)        ← 獎勵盤面，9 格
→送出 bonusgame         str(16)
→送出 throwResultDice   str(36) str(16) str(3)    ← 獎勵階段擲骰
←收到 throwResultDice   num num
←收到 resultSuccess     arr(9)
→送出 bonus_get         str(36)
←收到 bonus_end         num ×9
→送出 duel_end          num
←收到 db_player         obj{name,exp,level,win,lose,draw,win_ranked,lose_ranked,
                            draw_ranked,gem,point,cost,…}
→送出 duel_end          str(36) str(32)
←收到 duel_standby      obj{type,room_id,crossplay,multi,rule,room_stage,room_bgm,
                            room_playerAinfo,room_playerBinfo,
                            room_playerAdeck,room_playerBdeck,bonusgame,…} bool obj{…}
```

**人物升等**在 `db_player` 裡 —— `exp` 與 `level` 都有，戰績（`win`/`lose`/`draw`，
含 ranked 版本）與 `gem`/`point` 也一起給。

---

## `duel_standby` 解掉兩題，也帶來一個 §12 危險

```
obj{type, room_id, crossplay, multi, rule, room_stage, room_bgm,
    room_playerAinfo, room_playerBinfo, room_playerAdeck, room_playerBdeck, bonusgame, …}
```

### ✅ probe #4：`room_id` 存在

ulgg 要把兩個玩家配成一場對戰，需要一個雙方都看得到的穩定鍵。`room_id` 就是。
（送出側每個動作都帶的那個 `str(36)` 很可能也是它，但仍未證實 —— 要比對值。）

### ✅ 座位的權威來源

`room_playerAinfo` / `room_playerBinfo` 直接定義了誰是 A、誰是 B。這比從
`okVisibleX` 反推更早（進房就有）也更明確。**座位偵測應該優先用這個**，
`okVisibleX` 當備援。

### ⚠ **客戶端收得到對手的牌組**

`room_playerBdeck` 就在同一個物件裡。也就是說：

- 對手牌組**技術上拿得到**，但 §12 硬規則明訂隱藏資訊不得使用、顯示或上傳
- open-questions #2（壓 C 的「差距」是不是我方與對方隊伍總 COST 的差距）
  因此**不能**靠讀封包解決 —— 就算算得出來也不准。那題的 (a) 選項仍然只能
  靠雙方回報給 ULGG
- 牌譜與實況轉播要**明確排除**這兩個欄位，不能只是「沒去用」

這條要進白名單／黑名單，不能靠自律 —— 見下面的建議。

---

## 直接讀遊戲原始碼（2026-08-02 才發現，早知道能省很多事）

`E:\unlight_crawler` 的鏡像裡，`client/` 底下**同時有兩種 build**：

| 檔名                              | 內容                                      |
| --------------------------------- | ----------------------------------------- |
| `495.<20位hash>.js`               | 上線用的壓縮版，單行、識別碼全被改名      |
| `495.js`、`unlight.js`（5.2MB）   | **dev build —— 有原始參數名、可讀的排版** |
| `src_game_Main2_ts.js`（699KB）等 | 按原始 TypeScript 模組切開的版本          |

webpack 的模組標頭甚至保留了原始路徑（`./src/helper/battle/CardOpen.ts`）。

**這比黑箱觀察強太多。** `cardclickedX` 第二個布林的問題卡了三場對戰、十幾個
樣本都問不出來，而在原始碼裡它就明明白白寫著 `sound`：

```js
player_card_clicked(card_index, clicked, sound);
```

一個純顯示用的旗標，光靠觀察永遠推不出來 —— 因為它在正常遊戲流程裡不會變。

### 用法建議

- **語意問題先查原始碼**（「這個參數是什麼」「這個事件何時發」）
- **行為問題才用觀察**（「實際跑起來是幾秒」「伺服器真的會不會送」）
- ⚠ 鏡像是 2026-07-29 的 dev build，**不是**線上跑的那份。語意通常一致，
  但要對版本負責的判斷（例如 bundle 檔名）仍然只能問活著的客戶端。

### 順帶：手牌與已出牌的 y 座標是寫死的

```js
value[0].y === 510; // 手牌
value[0].y === 380; // 已出牌
```

比「追蹤場上 num 集合」更直接 —— 至少對**我方**而言。對手側仍然只能用集合法，
因為我們讀不到對手的 `arr1`。

---

## 對照表：用**活著的客戶端**，不要用鏡像檔

`window.game.cache.json` 裡有 28 份表，全部是這個版本的真貨：

```
achievements  avatar_item  avatar_parts  cc_asset  charaProfile  event_info
exp_table  lobby_achievement  lobby_reward  lot_bronze  lot_gold  lot_silver
lot_special  mc_asset  mc_boss  monsProfile  news  passiveskills  quest
quest_lands  queststory  rules  shop  shop_event  stamp_info  state_info
unlight-assets  voice
```

`E:\unlight_crawler` 有整站鏡像（含這些 JSON），拿來離線探索很好用，
但**不要把它的副本打包進 companion** —— 理由跟 bundle 檔名完全一樣：
遊戲改版就會漂移，而且沒有任何辦法偵測。`patch-cost.ts` 讀 `cc_asset` 已經
是走 Phaser 快取，其餘照辦。

### 幾份對 WP-12 特別關鍵的

| 鍵              | 內容                                                     |
| --------------- | -------------------------------------------------------- |
| `state_info`    | **27 種狀態效果**，見下                                  |
| `passiveskills` | 被動技能（`id` / `passive_skill_no` / 五語系名稱與說明） |
| `charaProfile`  | `cc001` → 五語系角色名、聲優、技能說明                   |
| `cc_asset`      | 角色卡（`filename` / `cost` / hp/atk/def / 四個技能）    |
| `mc_asset`      | 怪物卡，另有 `id`（1001…）與 `slot` 陣列                 |
| `exp_table`     | 升等門檻                                                 |

### `state_info` 的 27 種狀態

```
poison  poison2  mahi  atkB  atkD  defB  defD  movB  movD  bers  stun  huin
jikai  immo  scare  rege  bind  chaos  stigma  dbuff  sticka  stickd  curse
critical  control  target  dark
```

每一筆有五語系的 `*_log`（訊息模板，帶 `__NAME__` / `__POINT__` 佔位符）
與 `*_clip`（說明）。`__POINT__` 就是剩餘回合數。

**V1 移動規則第 3 條要的三個狀態全在這裡**：

| 規則 3 的條件 | 鍵      | 說明                 |
| ------------- | ------- | -------------------- |
| 麻痺          | `mahi`  | 「移動值變為 0」     |
| 降低移動      | `movD`  | （`movB` 是提升）    |
| 剩一回的自壞  | `jikai` | 回合數在 `__POINT__` |

> ⚠ **這更正了 `battle-features.md` 先前對規則 3 的評論。** 那裡說「需要一個
> 現在完全不存在的狀態效果模型」、建議 V1 退化成單一條件 —— 不成立。
> 模型就是 `state_info`，`state` 事件帶著鍵，回合數也拿得到。
> **規則 3 的完整條件可以直接實作。**

### ⚠ 名詞：公牌叫**行動卡**，跟**事件卡**是兩種東西

| 名稱       | 是什麼                                               |
| ---------- | ---------------------------------------------------- |
| **行動卡** | 公牌。五類：移動／近距離攻擊／遠距離攻擊／防禦／特殊 |
| **事件卡** | 自己帶的，牌組最多 18 張，**每回合發一張**           |

⚠ **`event_asset.json` 這個檔名會誤導** —— 它裝的是**行動卡**的定義：

```json
{ "type":7, "cost":0, "swd1":1, "gun1":0, "shi1":0, "mov1":0, "spe1":0,
  "swd2":1, "gun2":0, …, "draw":0, "break":0, "heal":0,
  "holy": false, "holy_enemy": false,
  "name_tcn": "劍1卡", "info_tcn": "此卡當作劍1使用" }
```

「劍1卡／此卡當作劍1使用」就是近距離攻擊強度 1 的行動卡。手牌的 sprite 也是用
`event_asset` 這個材質（實測 `MainA y≈520 Sprite [event_asset]` ×5）。

### `*1` / `*2` 是卡片的上下兩半

`swd1`/`gun1`/`shi1`/`mov1`/`spe1` 與 `swd2`/`gun2`/… 是**同一張牌的兩半**。
玩家說明過「卡牌上方是生效的那一半，數字表示強度」—— 所以**轉牌就是翻面決定
用哪一半**，這也是為什麼 `rotate` 是獨立事件而不是出牌的一部分。

### ⚠ 聖水／聖杯屬於哪一類，還沒確認

`holy` / `holy_enemy` / `draw` / `break` / `heal` 這些欄位長在**行動卡**的結構上。
但玩家說聖水、聖杯、機會1、機會3、詛咒卡是「打出去就消失」的消耗牌，
而且會凍結倒數。

**先前這份文件把它們歸給「事件卡」，那是未經證實的推論，已收回。**
要確認得看一場真的帶了事件卡的對戰 —— `eventCard` 事件（一場 4~8 次，
頻率對得上「每回合一張」）送來的物件是不是同一個結構。

規則 3 的「手牌有聖水、聖杯」判斷依據仍然是 `holy` / `holy_enemy` 這兩個布林，
這點不受影響 —— 不確定的只是那些牌在遊戲術語裡歸在哪一類。

---

## ⚠ socket 的壽命：原型跨場活著，實例**每場換一顆**（2026-08-03 實測）

改前端的東西有兩種掛法，而它們的壽命完全不同。混用而沒有意識到這件事，
會做出一個**只壞一半**的插件 —— 那比整個壞掉難查得多。

`MainA` 的原始碼（`String(game.scene.keys.MainA.constructor)` 讀出來的）：

```js
"quest" !== rule && "raid" !== rule && "event" !== rule
  ? this.socket = this.scene.get("MatchBoot").socket   // 對戰：跟 MatchBoot 借
  : this.socket = new WSClient(...)                    // 任務／raid／活動：自己 new
```

而 `MatchBoot` 自己是 `this.socket = new WSClient(...)`，**每次進配對就 new
一顆**。實測對戰中 `MainA.socket` 與 `MatchBoot.socket` 是同一個 id
（`b5feba54-…`），證實對戰確實共用 MatchBoot 那顆。

| 掛在哪                      | 重新開房之後 |
| --------------------------- | ------------ |
| `WSClient.prototype.emit`   | ✅ 還在      |
| `socket.onAny(...)`（實例） | ❌ 沒了      |

### 為什麼這特別危險

WP-12 兩種都用：攔 `I_am_ok` 靠原型，收出牌／轉牌事件靠實例。換房之後
**攔截還活著、解除攔截的觸發源死了** —— 插件變成一把單向的鎖：壓住你的 OK，
但任何操作都不再取消準備。

症狀（玩家 2026-08-03 回報）是「出牌不會取消準備」，看起來完全像仲裁邏輯寫錯，
實際上邏輯一行都沒問題。**任何同時用到兩種掛法的功能都得自己偵測 socket 換過
了沒**（`patch-ok.ts` 的 `arm()`），而且拆的時候要 `offAny`，否則重灌幾次就有
幾份監聽，同一則事件回報好幾次。

> 這也是為什麼 `installOkPatch()` 現在**不需要先進對戰**：沒有 socket 就先空轉，
> 每 200ms 自己去看有沒有出現。玩家的實際順序是「先開插件再開遊戲」。

---

## 還沒解的問題

1. **`cardclickedX` 那兩個 bool 是什麼？** 出牌/收牌的區分很可能在這裡。
   要讀值，但 §12 擋著。可行的折衷：**只對自己座位的事件、只對布林與小整數**
   開放記錄值，字串一律不記（token 與 UUID 都是字串）。對手座位的 `num`
   絕對不能記 —— 移動階段的牌是蓋著的，那是隱藏資訊。
2. **`str(36)` 是不是 match id？** 需要比對兩個客戶端送的是否同一串。
   建議做法：回報**雜湊前綴**（例如 `str(36)#a3f1`）而不是值本身。
   UUID 與 token 都是高熵的，16 bit 前綴不足以反推，卻足以比對是否相同。
3. **`okInvisibleA/B` 這次一次都沒出現。** §4 用 `okVisibleA → okInvisibleA`
   當倒數區間（實測 31.0 秒）。這場 12 個階段全都是雙方按 OK 提早結束，
   所以沒有觸發。要量倒數就得**故意讓它跑到自然結束**。
4. **`move_select` 為什麼是雙向的？** 唯一會回送給自己的操作事件。
   移動階段仲裁正好在這個階段，值得先搞清楚。
