# 公開渦通知（raid-feed）：用玩家取代觀測站

> 2026-10-03 定案。取代 ulgg 觀測站（`unlight_crawler/src/script/raid_bot`，Python + VPS + 小號）。

## 目標

Discord 的公開渦通知照舊，但**不要 VPS、不要小號、不要登入 session**。資料全部來自開著插件的玩家，
插件只在玩家本來就會做的操作裡**順手**抓；彙整與發 Discord 放在現有的 Cloudflare Worker（`apps/link-worker`）。

以最低維護成本為目標：沒人玩的時段沒有通知，這是接受的代價。

## 定案的取捨

| 問題                 | 決定                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| 發現者名稱上不上雲端 | **上**。Discord 訊息本來就公開它（舊 bot 一直這樣發）                                 |
| 雲端資料給不給讀     | **給讀**（`GET /raid-feed`）。順便取代 ulgg 的 `observed_raids`，插件少一個第三方依賴 |
| 假資料               | **暫時完全信任**。只沿用現有的令牌桶限流與形狀驗證                                    |
| 主動刷新 SUPPORT     | **不做**。客戶端自己收到公開清單時才抓（玩家打開 SUPPORT 面板）                       |
| 渦碼                 | **永遠不上傳**。渦碼＝門票（見 `raid-share.ts` 開頭）                                 |

## 資料從哪來

```
① SUPPORT 公開清單（客戶端收到時）      → 建立渦（唯一能「新增」的來源）
② 自己的渦清單 raid_list（進渦房／Refresh）→ 只補資料：stage、HP、★、map_index
③ 戰鬥開場看到的 stage（__ulrRaidStages）→ 經 ② 一起送
```

- **只有 ① 能新增渦。** ② 裡有 `only_friend` 的渦，拿它新增等於把好友限定的渦公告出去。
  ② 送上來的渦若看板上沒有（沒在 SUPPORT 出現過），Worker 直接丟掉。
- **① 也只有「不是發現者好友」看到的才能新增**（2026-10-09）。官方公告：「若發現者將參加資格設定為
  ｢僅限好友｣，非該玩家好友時將不會顯示該Raid」——好友的 SUPPORT 會列出僅限好友的渦，列上又沒有參加資格欄位。
  頁面拿 `registry.get("friend")` 的名字比對，每列帶 `founderFriend`；`true`、`null`（讀不到好友名單）、
  沒帶（舊版插件）都只更新帳本上已經有的渦。先僅限好友、後來改公開的，等非好友看到再發。
  發現者自己按送出（`publish`）照舊能新增（頁面只記「無限制」的）。
- **好友看到之後加入了，看清單的 `only_friend`**。加入者讀到的是真的值（2026-10-09 驗過：燈皇是 Kotoma 的好友、
  不是發現者，讀到 Kotoma 沒公開的玄帝 `true`、公開的龍鯉 `false`）。托盤記著「在好友的 SUPPORT 看過」的渦
  （只放記憶體），加入後讀到 `false` 就以 `own` 帶 `onlyFriend: false, seenInSupport: true` 傳上去新增。
  `false` 一定要配「在 SUPPORT 看過」：沒按送出的渦也是 `false`。
- **公開後才改成僅限好友的，靠 ② 撤下**：清單上 `only_friend: true` 就標 `friendOnly`——沒發的不發、
  發了的從那則拿掉一行（整則都是就刪訊息，裡面的渦當作沒發過）、GET 不列、整份 SUPPORT 判打倒時跳過。
  之後又證明公開（上面三種），就放回來（訊息還在加回那一行，被刪了補發新的一則）。
- **碎片不用 map_index 公式。** `raid-public.ts` 記著 2026-09-25 兩筆實測 map_index 公式都錯、
  stage 都對；`infer_fragment.py` 又說 40/40 全對。有矛盾就不用。依序：
  1. 玩家實際看到的 stage（開打時）
  2. **ulrmap 獎勵表**（2026-10-03 加）：自己清單的 怪＋★＋區塊（`map_index`）拿去查
     `POST https://www.ulrmap.wiki/api/raid-rewards-v2/lookup`，排名獎勵裡的 `cmem` 就是碎片。
     **有人加入就查得到，不必等開打。** 回的名稱是簡體（`locale=zh-TW` 也一樣），繁簡都認。
     渦 I 的排名獎勵是渦幣（`ccoin`）不是碎片：同一格同一色（鐵黃、銅綠、銀藍、金紅、白金紫），
     沒有 `cmem` 才看它（2026-10-04 修；之前渦 I 要等有人開打才知道）。
     查不到的組 30 分鐘後再查。查表在 Worker 的 alarm 裡、發這一批之前做，所以還沒發的直接帶碎片。
  3. 都沒有 → `❓`，之後知道了再改訊息。

### 辨識同一個渦

`發現者 + 發現時刻`（`raidTeamRef`，隊伍看板用同一組）。改版後別人的渦碼是 null，這組是清單上每個人都看得到的。
不用到期時刻：渦死後伺服器把 limit 改成「死亡＋10 分」，鍵會變，同一個渦會被當成新的再發一次。

## API（Worker）

### `POST /raid-feed`

```jsonc
{
  "source": "support" | "own",   // ① 或 ②
  "raids": [{
    "founder": "名字",
    "foundAt": 1789980000000,    // 發現時刻 ms（鍵）
    "limit": 1790000000000,      // 到期時刻 ms
    "monsterId": 30130,          // 或 null
    "name": "龍鯰",              // BOSS 名
    "rarity": 1,                 // 或 null
    "level": 1,                  // 或 null
    "hp": 12000, "hpMax": 20000,
    "memberLimit": 100,          // 或 null；判斷渦 I／IV 用
    "stage": 3,                  // 只有 own 會有；或 null
    "founderFriend": false,      // 只有 support：上傳的人是不是發現者的好友（只有 false 能新增）
    "onlyFriend": null,          // 只有 own：清單的參加資格（true 撤下；false 要配下一欄才算公開）
    "seenInSupport": null        // 只有 own：上傳的人在好友的 SUPPORT 看過它（＝送出了）
  }]
}
```

形狀驗證沿用 `raid-share.ts` 的做法（整數範圍、到期時刻不超過現在 + 24h、字串長度上限），
限流沿用 `RaidBoardRoom` 的令牌桶。

### `GET /raid-feed`

回目前還沒到期的渦（同上欄位 + `seenAt`、`fragment`），**沒有渦碼**。插件的 `raid-public.ts`
改讀這裡，ulgg 留作備援或拿掉。

`fragment` 跟著公開渦表推到頁面（`feedToPublicMap`；`mergePublicMaps` 合併時保留）。頁面用在兩處
（2026-10-04）：自己清單上 stage 還不知道的渦，以及 **SUPPORT 清單**（patch-raid-view ⑫）——
還沒加入的渦沒有自己看到的 stage、也沒有區塊，只能靠這個。SUPPORT 每列用頁面裡的渦碼對回
`Raid.raid_support`、再用發現者＋到期時刻查表；碎片圖示掛成那一列的欄位，官方開關面板、翻頁時一起收。

## Worker：`RaidFeedRoom`（新 Durable Object）

全世界一個實例（跟 `RaidBoardRoom` 同理由：量小、要同一份記憶體）。用 SQLite storage，
因為 Discord 訊息 id 要撐過 DO 被回收。

```
POST support 帶來沒看過的渦
  → 存起來，狀態 pending
  → 沒排 alarm 就排 now + 30s（固定窗，後到的不延長 —— 跟舊 bot 一樣）
alarm
  → pending 的整批發一則 Discord（webhook ?wait=true 拿回 message id）
  → 存 message id；渦幾都發（2026-10-04 起渦 I 也發）；有渦 IV（120）就 mention 一次 role
POST 帶來某個渦的 stage（之前是 null）
  → 算碎片，PATCH 那則 Discord 訊息（編輯不重新 mention）
alarm（順便）
  → 刪掉已到期的渦
```

`DISCORD_WEBHOOK_URL` 用 `wrangler secret put`，`DISCORD_RAID4_ROLE_ID` 放 `vars`。

新增 DO 要在 `wrangler.jsonc` 的 `migrations` **往後加** `v5`（不要動 v1–v4）。

## 訊息格式（從 Python 移植）

照舊 bot，放進 `@ulr/arbiter-link`（Worker 與測試共用、純函式）：

```
🆕 新增 2 個公開渦
發現者A 紅海🔴🐙 12000/20000
發現者B ❓龜🐢 30000/30000｜✨6★
```

移植來源（`unlight_crawler/src/script/raid_bot/raid_bot/`）：

- `formatter/raid_notification_text.py`：一行的組法、批次標題
- `domain/monster_rules.py`：怪的簡稱與 emoji
- `formatter/fragment_display.py`、`domain/protocol14_fragment.py`：stage → 碎片顏色（★6 錯一格）
- `services/fragment_resolver.py`：渦 I／IV 判斷（人數上限 80 / 100 / 120）

不移植：3 小時完整摘要、REMOVED／ENDED 通知、TL 版 Reward API（改用 v2 lookup，見上）、map_index 公式。

已經死掉（HP 0）的渦不公告：沒用，而且死渦的到期時刻會變。

**公開的渦幾都發**（2026-10-04 使用者訂的）。舊 bot 不發渦 I，照搬之後龍魚公開了卻沒上 Discord。
帳本上以前被跳過、沒發過、不是發失敗（`failed`）的渦，下次再收到時還活著就改回 pending 補發。

## 訊息什麼時候改（2026-10-03）

**有事就改；只有 HP 變了的，同一則最多一分鐘改一次**（玩家 30 秒傳一次，每次都改會洗編輯紀錄、撞 Discord 限速）。

| 事件                                     | 怎麼改                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| 碎片知道了（看到 stage、或 ulrmap 查到） | ❓ 換成顏色                                                             |
| HP 變了                                  | 換成最新 HP；離上次改不到一分鐘就排在一分鐘後                           |
| 打倒了                                   | 那一行變 `☠️ 0/上限`，狀態不再顯示（怎麼知道打倒見下）                  |
| 判成打倒之後又看到活的                   | 改回來                                                                  |
| 有人開打、看到比較新的 BOSS 狀態         | 換成新的那份：`｜麻 移-9 詛9`（短字與順序照舊 bot 的 `status_text.py`） |
| 狀態到期，期間沒人帶新的來               | 到期那一刻重畫，把它拿掉                                                |
| 渦到期還沒打倒                           | 到期那一刻標 `⌛`                                                       |

| BOSS 被動換了（見下） | `｜硬化` 這一段換掉；HP 跨過門檻不等一分鐘的限流 |

「到期那一刻」：訊息記著下一次要自己重畫的時刻（`stateExpiry`），alarm 排在那一刻。

### BOSS 被動（2026-10-04）

六隻 BOSS 的被動看現實時間或渦的 HP 開關，伺服器不送「現在開哪個」，照規則算
（`arbiter-link/src/raid-passive.ts`，抄原版 Unlight 伺服器 `chara_card.rb` 的 `check_*_passive`）：

| BOSS           | 被動                   | 什麼時候開                                                   |
| -------------- | ---------------------- | ------------------------------------------------------------ |
| 狗（mc1003）   | 硬化／吸收             | 分鐘 10–19、40–49／20–29、50–59                              |
| 蟲（mc1006）   | 潛伏地中／濁濫的盡頭   | HP ≤ 3/5 且 > 2/5／≤ 2/5                                     |
| 海（mc1007）   | 籠罩的夜霧             | HP ≤ 1/2                                                     |
| 龜（mc1008）   | 隱身                   | HP ≤ 1/3                                                     |
| W.M.（mc1009） | 收穫                   | HP ≤ 1/2                                                     |
| 翔蟲（mc1013） | 磁氣暴風（標「磁暴」） | HP ≤ 1/2，**而且打的人那隻也 ≤ 1/2**（只算得到 BOSS 這半邊） |

其他渦 BOSS 的被動不標：千古不朽／連動與各種狀態抗性一直開著；A.W.C.S.（惡魔之角）每回合隨機換防禦距離，渦外看不出來。

一行裡排在 ★ 後面、BOSS 狀態前面：`燈皇 ❓狗🐶 40000/50000｜✨6★｜硬化｜麻`。死了、到期了不標。
狗的訊息每 10 分鐘自己重畫一次（`nextRaidPassiveChange` 進 `stateExpiry`）。渦房畫面也標
（patch-raid-view ⑬，清單列、詳細面板、SUPPORT 的 BOSS 名右邊），表在 `cdp-adapter/src/raid-passive.ts`
有一份複本，`arbiter-engine/test/raid-passive-parity.test.ts` 對兩份。

⚠ **第 19／49 分還沒實測。** 原版伺服器碼是 `(10 .. 19)`（含 19），玩家記得「19–20、49–50 分沒有被動」
（如果改版後寫成 `10...19` 就會這樣）。戰鬥裡官方的被動框會跟著伺服器點亮／變暗，patch-raid-view 把每次
亮暗變化記在 `window.__ulrRaidPassiveLog`（時刻、HP、亮著的 id）—— 打一場跨過第 19 或 49 分的狗就知道。

### 怎麼知道打倒了

1. 有人的清單看到 HP 0。頁面**第一次看到的當下**就叫托盤傳（打渦腳本可能很快就把死渦刪掉）
2. 到期時刻往前跳（伺服器把 limit 改成「死亡＋10 分」）
3. **新鮮的整份 SUPPORT 裡沒有** = 不見了，當作打倒。托盤傳 SUPPORT 時標 `complete`，並附上傳的人
   自己清單上還活著、帳本上已經有的渦（`present`，不確定 SUPPORT 會不會藏掉自己加入的）。
   不判斷：剛發現 2 分鐘內的、已經到期的、上次看到滿人的（不確定滿人會不會從 SUPPORT 消失）。

### 不公開的渦不會外流

輸入渦碼加入的、好友限定的渦（不在 SUPPORT 公開清單裡）：

- 帳本只能由 SUPPORT 或發現者自己公開（`publish`，見下）新增；`own` 送來帳本上沒有的渦，Worker 直接丟
- 托盤補資料（`own`）、附 `present` 都只送**帳本上已經有的**渦
- 渦碼在頁面裡就丟掉

### 自己開、自己公開（`publish`）

發現者在渦碼視窗按「送出」→ 確認 OK，官方送 `socket.emit("raid_code_send", profound_id)`。
參加資格（同一個視窗的下拉選單「無限制／僅限好友」，伺服器記在 `only_friend`）是「無限制」時就是公開給所有人。
頁面包 `Raid.socket.emit`：看到 `raid_code_send`、而且那個渦 `only_friend !== true`，記進
`window.__ulrRaidPublished`、叫托盤馬上傳（`source: "publish"`，能新增渦）。**僅限好友的一律不記。**
不必等別人打開 SUPPORT。

### 渦幾（2026-10-03）

清單只給 `monster_id`；`CharaCards` 查得到 BOSS 代碼（`chara`，例如 `mc1006_02`）—— 官方 SUPPORT 畫 BOSS 名也是這樣查。
規則照 Moon/打渦.py 的 `渦階()`（`raidFeedTierOf`）：

| 代碼              | 渦幾                  | BOSS（2026-10-03 實機 CharaCards）                                               |
| ----------------- | --------------------- | -------------------------------------------------------------------------------- |
| `_01`             | 渦I                   | 赤死獸、啃食者、深沉之者、贔屭、W.M.貴族、惡魔之角、可可果的惡靈、龍魚、翔空蟲   |
| `_02`             | 渦II/III              | 黑死獸、屠殺者、誘引之者、靈龜、W.M.公主、惡魔之角-Y、可可果的妖靈、龍鯰、翔天蟲 |
| `_03`             | **渦IV**（@渦4）      | 瘟疫、爬行者、深奧之者、玄帝、W.M.王后、惡魔之角-S、可可果的精靈、龍鯉、翔星蟲   |
| `mc1004` 妖精     | ★5 渦IV、其他渦II/III |                                                                                  |
| `mc1005` 吸血女王 | 渦I                   |                                                                                  |

代碼看不出來（沒有代碼、妖精還不知道 ★）才退回人數上限（80 / 100 / 120）。

BOSS 狀態改版後只有**開打那一刻**看得到，而且有持續時間：頁面記下狀態時就通知托盤（`raid-stage`），
托盤**戰鬥中就傳**，不等打完回渦房那一輪。

## SUPPORT 清單要新鮮（2026-10-03 事故）

`Raid.raid_support` 關掉面板也不清，可能是一小時前的樣子。桌面版很早以前開過 SUPPORT，換上新版插件後
那份舊清單被當新渦傳上去，一個早就死掉的渦（クラゲ 870/1200）被發到 Discord。

修法（`raid-support.ts`）：包 `create_raid_support`，拿完資料時在陣列上標時刻，**只交插件包上之後、
1 分鐘內拿到的那份**。拿到的當下也通知托盤馬上傳（跟著玩家按 SUPPORT 走）；插件的 Refresh（⑩）本來就會
叫托盤馬上跑一輪。

**攔截要在按 SUPPORT 之前裝好**（2026-10-03 漏掉一隻妖精）：原本只在托盤 30 秒那一輪順手裝，遊戲重整完
一進渦房就按 SUPPORT、看到就加入 —— 那份回應沒攔到，加入之後 SUPPORT 也不再列它（**加入過的渦 SUPPORT 不列**，
同一天加入黃狗後那份 SUPPORT 是空的），就再也補不回來。現在 raid-view（連上就裝、每 300ms 一拍）在渦房裡
每拍都確認一次，進渦房下一拍就裝好。

## 程式在哪

| 檔案                                              | 做什麼                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/arbiter-link/src/raid-feed.ts`          | 規則：形狀驗證、碎片、渦等級、Discord 文字、帳本 `RaidFeedBook`（純記憶體） |
| `apps/link-worker/src/raid-feed.ts`               | `RaidFeedRoom`：storage、alarm、打 Discord                                  |
| `packages/cdp-adapter/src/raid-support.ts`        | 讀 `Raid.raid_support`（頁面裡丟掉渦碼）                                    |
| `packages/arbiter-engine/src/raid-feed-client.ts` | 托盤：`RaidFeedSync`（GET、傳 SUPPORT、補 ★／stage）                        |
| `engine.ts` 的 `#refreshRaidPublic`               | 渦房裡每 30 秒那一輪接上去；上傳跟著互傳開關                                |

托盤記著上一次傳成功的 SUPPORT 清單，同一份不重傳；`own` 先 GET 再補帳本缺的（只補 null、不蓋別人的），
不靠本機記憶，失敗下一輪自己補。

## 部署

```
npx wrangler secret put DISCORD_WEBHOOK_URL      # 在 apps/link-worker 底下
# wrangler.jsonc 的 vars.DISCORD_RAID4_ROLE_ID 填渦 IV 要 mention 的身分組（空的就不 mention）
npm --workspace apps/link-worker run deploy
```

部署後看 `npm --workspace apps/link-worker run tail` 的 `raid-feed:` log：每次 alarm 印「一批幾個、webhook 有沒有設」，
發不出去印 HTTP 狀態碼（不印 webhook 本身）。

⚠ **本機 `wrangler dev` 測 Discord**：2026-10-03 實測 `--var`／`--env-file` 給的 `DISCORD_WEBHOOK_URL`
在 DO 裡讀不到（`vars` 裡宣告的才讀得到）。本機要測就**暫時**寫進 `vars`、指向假的 webhook，測完改回來；
正式環境用 secret。⚠ secret 跟 `vars` 不能同名，部署前 `vars` 裡不能有 `DISCORD_WEBHOOK_URL`。

## 實機確認（2026-10-03，瀏覽器版＋桌面版對照）

SUPPORT 面板：按鈕 `Raid.raid_support_btn` 的 `click` → `create_raid_support()` →
`this.raid_support = await this.socket.fetch("db_raid_support")`。**原始列放在場景的 `Raid.raid_support`，
關掉面板後不會清掉**（`close_raid_support` 只清畫面用的 `raid_support_list`），下次打開才整批換掉。
所以插件不用包任何方法，托盤照常輪詢時順便讀 `Raid.raid_support` 就好。

```
Raid.raid_support[i] = { profound_code（渦碼，不上傳）, raid_name, monster_id, founder_name,
                         hp, hp_max, limit, profound_date, member_length, member_limit }
```

- **沒有 rarity／level**：★ 與 Lv 只能等有人加入後由 `source=own` 補。
- 對照同一批渦在發現者自己的 `raid_list`：`founder === founder_name`、`limit` 完全相同、
  `found_at === profound_date`。**發現者＋發現時刻當鍵成立。**
- `limit − profound_date` = 6 小時。
- 按插件的 Refresh（⑩）**不會**重抓 SUPPORT，只有打開 SUPPORT 面板會。
