---
name: probe-game
description: 對著跑著的 UNLIGHT:Revive 客戶端查東西 —— 場景物件、事件、遊戲原始碼、UI 座標、注入腳本的實際狀態。任何「遊戲裡的 X 長什麼樣 / 叫什麼名字 / 在哪個座標 / 我改的東西到底生效了沒」都用這個。憑記憶或憑猜測回答這類問題幾乎都會錯。
---

# 查遊戲裡的東西

**先分清楚你要查的是「行為」還是「資料」** —— 來源完全不同：

| 要查的                                        | 去哪                                       |
| --------------------------------------------- | ------------------------------------------ |
| 場景、按鈕、事件、座標、時序 —— **行為**      | 跑著的客戶端（這份的其餘部分）             |
| cost 表、角色需求、任務文本、成就 —— **資料** | `E:\unlight_crawler\steam\data\`（已爬好） |

⚠ 別為了查 cost 去戳遊戲。crawler repo 已經有現成 CSV：
`cost_cc.csv`、`cost_weapon.csv`、`cost_event.csv`、`cc_require.csv`、`qp.csv`。

⚠ 反過來也一樣：**crawler 裡沒有客戶端原始碼**，`crawler.py:32` 的
`EXCLUDE_KEYWORDS = ["phaser"]` 刻意把引擎 bundle 排除掉了。行為問題在那裡
找不到答案，只能問跑著的客戶端。

## 先確認有東西在跑

```powershell
npx tsx apps/companion/src/index.ts probe --port 9334
```

連不上就是沒開。開法看 [docs/launching.md](../../../docs/launching.md)：

| 客戶端 | port | 怎麼開                                          |
| ------ | ---- | ----------------------------------------------- |
| 桌面版 | 9333 | Steam 啟動選項加 `--remote-debugging-port=9333` |
| 網頁版 | 9334 | `tools/open-game.ps1`，或 `companion web`       |

雙開可以同時接兩個 —— **有些東西單邊看不出來**（見下面「座位」）。

## 基本形狀

寫一支拋棄式腳本丟到 scratchpad，不要放進專案：

```ts
import { createCdpAdapter } from "@ulr/cdp-adapter";

const adapter = createCdpAdapter({ port: Number(process.argv[2] ?? 9334) });
try {
  await adapter.connect();
  await adapter.waitForGame();
  const out = await adapter.evaluate<string>(`(function () {
    try {
      // ← 在這裡問
      return "答案";
    } catch (e) { return "錯誤：" + String(e && e.message); }
  })()`);
  console.log(out);
} finally {
  await adapter.disconnect();
}
```

跑：`npx tsx <路徑>.mts 9334`

**注入的程式碼一定要包 try/catch 並回傳字串。** 例外會變成一句沒有上下文的
「注入的程式在遊戲裡拋例外」，什麼都查不到。回傳字串而不是物件，是因為序列化
失敗的錯誤同樣沒有上下文。

`adapter.evaluate()` 會自動處理「遊戲在 iframe 裡（桌面版）還是 top-level
（網頁版）」的差別，不必自己找 execution context。

## 常用的問法

以下都在 2026-08-02 的實測中用過。

**有哪些場景 active** —— 判斷目前在哪個階段最可靠的方式：

```js
Object.keys(window.game.scene.keys)
  .filter(function (k) {
    return window.game.scene.keys[k].scene.isActive();
  })
  .join(", ");
```

實測：移動階段 `MovePhaseA` active，攻擊階段換成 `AttackPhaseA`。
**不要用畫面上的階段列文字判斷** —— 那是圖，而且 A/B 座位的標籤會換。

**某個場景裡有哪些顯示物件**（找按鈕、找倒數的座標）：

```js
sc.children.list
  .map(function (o) {
    return [
      o.type,
      o.texture && o.texture.key,
      Math.round(o.x),
      Math.round(o.y),
      o.text !== undefined ? JSON.stringify(o.text) : "",
    ].join(" ");
  })
  .join("\n");
```

**遊戲自己的原始碼** —— webpack 打包過，但類別的原始碼還在：

```js
String(window.game.scene.keys.MainA.constructor.toString());
```

拿到之後 `indexOf("pointerover")` 之類的往前後切一段來看。
OK 鈕那組 hover handler 就是這樣挖出來的。

**我注入的東西現在是什麼狀態** —— 改前端的功能一定要有這一步：

```js
var A = window.__ulrArbiter;
[
  A ? "已裝" : "沒裝",
  "held=" + !!A.held,
  "tinted=" + A.tinted,
  "listeners=" + sc.ok.listenerCount("pointerout"),
].join("  ");
```

## 三個會讓你查錯的坑

**1. ⚠ 頁面上跑的可能是舊版腳本。**

改了注入腳本、測試也綠了、實際跑起來卻沒反應 —— 第一個要懷疑的是**頁面根本
沒換到新版**。這個專案在 `ws-events` 與 `patch-ok` 上各栽過一次。

判斷方式：查一個新版才有的副作用（例如 listener 數量、新欄位存不存在），
不要查「行為對不對」—— 行為看起來錯，你會去改本來正確的程式碼。

`installOkPatch()` 會先拆再裝，`installWsWatch()` 只換設定（改邏輯要重載遊戲）。

**2. ⚠ 嚴格比對前先確認型別。**

`ok.frame.name` 是**數字** `2`，不是字串 `"2"`。拿 `=== "2"` 去比會得到
「壞掉」的假結論，而值其實是對的。探測腳本印出來的判斷語自己也會騙人 ——
**印原始值，不要只印判斷結果**。

**3. ⚠ A/B 是座位，不是敵我。**

`cardclickedA` 不是「我出牌」，是「坐 A 位的人出牌」。單邊錄看不出來，
兩邊同時錄比對次數才會浮出來。細節見 [docs/battle-events.md](../../../docs/battle-events.md)。

座位每場重新分配，**同兩個帳號連打兩場會對調** —— 不能快取。

## §12 邊界

錄事件流時**預設只記事件名、參數形狀與時間戳，不記值**。
`db_deck1/2/3` 的 `args[0]` 是 Steam session token。

對手手牌就算封包裡有也不得顯示或落地。牌譜功能特別容易違反這條 ——
「完整記錄」的直覺跟它衝突。

落地路徑要在 `**/battle/`、`**/deck/` 底下（`.gitignore` 已擋）。

## 錄一整場而不是問一個瞬間

```powershell
npx tsx apps/companion/src/index.ts watch --port 9334 --seconds 300
```

事件的**次數比對**通常比單次觀察有用得多 —— 上面「A/B 是座位」那條，
以及「`I_am_ok` 只送不收」，都是從次數表看出來的，不是從單一事件。
