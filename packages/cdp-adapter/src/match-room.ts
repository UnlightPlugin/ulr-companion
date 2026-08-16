/**
 * 自動開房／進房（WP-16）
 * =========================
 * 約戰配對湊成之後，這支負責驅動遊戲原本的開房與進房流程。**協定是實測挖
 * 出來的**，不是猜的：
 *
 * ```
 *   開房  emit("match_room_make", id, channel, name, stage, multi, friend, pass, cost, deckNow)
 *         → once("match_waiting")      成功
 *         → once("match_room_error")   失敗，帶 fail 代碼
 *         → once("duel_standby")       有人進來了，開打
 *
 *   進房  emit("room_in", id, channel, roomId, pass, deckNow)
 *         → once("duel_standby")       成功
 *         → once("match_room_error")   失敗
 * ```
 *
 * ## ⚠ 這支會改變遊戲狀態
 *
 * 開房會**消耗 AP 5**、會在公開的房間清單裡出現、會讓玩家進入對戰。
 * 跟這個 package 其他的注入不同（那些只改顯示），這裡是真的在替玩家操作。
 * 呼叫端必須是玩家明確按下的動作，絕對不能自動觸發。
 *
 * ## 房間密碼就是配對 token
 *
 * 遊戲自己的密碼是客戶端產生的 8 碼英數字串，當成普通參數送出：
 *
 *     pass: this.pass ? this.pass_string : null
 *
 * 所以插件可以指定成中間人給的那一組 —— 外人看得到那間房但進不去。
 * ⚠ **房名絕對不能包含 token**，那等於把密碼貼在公開清單上。
 *
 * ## 房間清單是公開資訊
 *
 * `channel{n}_room` 推送的每一筆都帶著 `deckA` / `deckB`（含 `chara`、
 * `charaIndex`、`cost`）—— 那是遊戲廣播給大廳裡**每一個人**的，MatchingLobby
 * 的房間列也確實會畫出雙方的卡片縮圖。所以拿它來驗「對手的牌組在約定規則下
 * 合不合法」不涉及隱藏資訊。
 *
 * ⚠ 但**不得**拿它來挑對手（看到不好打的就不配）。那不是 §12 的隱藏資訊問題，
 * 是運動精神問題，而且會讓整個約戰功能失去意義。
 */

import { embedJson } from "./embed.js";

/** 遊戲頻道裡一副公開可見的牌組。 */
export interface RoomDeck {
  /**
   * 這一格放的是誰。角色是 `cc069`，怪物是 `mc001_01`。空槽是 `null`。
   *
   * ⚠ **前綴決定 `charaIndex` 該查哪份資產** —— `cc` 查 `cc_asset`、
   * `mc` 查 `mc_asset`。查錯的話不會報錯，會拿到一張**存在但不相干**的卡。
   */
  chara: (string | null)[];
  /** `cc_asset` 或 `mc_asset` 的 `frames` 索引 —— 就是規則鍵要用的那個。 */
  charaIndex: (number | null)[];
  /** 伺服器算的 COST（原版規則）。 */
  cost: number;
}

/**
 * 一副牌組的四種規則鍵。空格保留成 `null` —— 呼叫端要分得出「這格是空的」
 * 與「這格有卡但我讀不到它是誰」，後者算出來的 COST 會少一項。
 */
export interface DeckKeySet {
  /** 三個槽位，角色（`cc078_04`）或怪物（`mc001_01`）。 */
  characters: (string | null)[];
  /** 三個槽位各自的武器（`wp001`）。 */
  equipment: (string | null)[];
  /** 18 格事件卡（`ev091`）。 */
  eventCards: (string | null)[];
}

/** 房間清單裡的一筆。只挑我們用得到的欄位。 */
export interface RoomEntry {
  roomId: string;
  name: string;
  /** 房主顯示名稱。host 靠它找出自己開的那間。 */
  playerAName: string | null;
  playerBName: string | null;
  /** 1 = 需要密碼 */
  pass: boolean;
  deckA: RoomDeck | null;
  deckB: RoomDeck | null;
}

export interface MatchContext {
  /** 玩家 id（`db_*` 呼叫都要帶）。⚠ 高熵字串，**不得離開本機**。 */
  hasId: boolean;
  /** 目前所在頻道。沒進頻道是 `null`。 */
  channel: number | null;
  /**
   * 全部頻道，兩組併在一起。實測（2026-08-15）：
   *
   * | # | 名稱             | type   | crossplay |
   * |---|------------------|--------|-----------|
   * | 1 | 亞歷山卓城       | ranked | false     |
   * | 2 | 迪特赫姆         | duel   | false     |
   * | 3 | 峰亥盧遺跡       | ranked | true      |
   * | 4 | 布萊德克洛伊茲   | duel   | true      |
   */
  channels: Record<string, ChannelInfo> | null;
  /** 目前頻道是不是跨平台頻道（走 `socket_cross`）。 */
  crossplay: boolean;
  /** 目前選的牌組（1/2/3）。 */
  deckNow: number | null;
  /**
   * 目前牌組的 COST。
   *
   * ⚠ 這是**伺服器用原版 COST 算的**，不是自訂規則的總和 —— 改寫 cc_asset
   * 不會改到它。要顯示自訂規則的總和必須自己加。
   */
  deckCost: number | null;
  /**
   * 目前牌組的**規則鍵**，四種卡都有。讀不到牌組時整個是 `null`。
   *
   * 這是配對用的東西：角色與怪物的鍵就是資產的 `filename`，而封包給的
   * `charaIndex` 就是那份資產 `frames` 的索引（docs/open-questions.md 第 1 題），
   * 所以只是查一次陣列，不需要任何對照表。裝備與事件卡沒有 filename，鍵是
   * 由索引組出來的（`wp001` / `ev091`，見 `@ulr/rule-schema` 的 card-key.ts）。
   *
   * ⚠ 這是**自己的**牌組。對手的牌組永遠不從這裡來。
   */
  deckKeys: DeckKeySet | null;
  /** 玩家顯示名稱。找自己開的房要用。 */
  playerName: string | null;
  /** 玩家自己是不是正在配對中（已經開了房在等人）。 */
  isMatching: boolean;
  /** Match 場景是不是 active。不是的話什麼都不能做。 */
  inMatch: boolean;
}

/**
 * 頻道編號 → 顯示名稱。**實測抄下來的**（2026-08-15 的 MatchingLobby），
 * 遊戲沒有把名稱放進 `channels` 物件裡，只有 type 跟 cost。
 *
 * ⚠ 只拿來**顯示**。判斷一律用編號與 `crossplay`，名稱換了不該影響行為。
 */
export const CHANNEL_NAMES: Readonly<Record<number, string>> = {
  1: "亞歷山卓城",
  2: "迪特赫姆",
  3: "峰亥盧遺跡",
  4: "布萊德克洛伊茲",
};

/**
 * 對戰地點。**照抄客戶端 bundle 裡的 `Match.STAGES.tcn`**（2026-08-15），
 * 不是自己編的。
 *
 * ⚠ **`"014"` 才是「隨機」，`"000"` 是雷德貝魯格城。** 這兩個很容易搞反 ——
 * 官方對話框預設選的是清單第一項（000），而不是隨機，所以大廳上一堆房是
 * `stage:"000"`，看起來很像「沒選 = 隨機」。
 *
 * ⚠ **不能傳 `null`**，伺服器會回 `fail: 20`。
 */
export const STAGES: readonly { value: string; name: string }[] = [
  { value: "000", name: "雷德貝魯格城" },
  { value: "001", name: "誘惑森林" },
  { value: "002", name: "垃圾之街" },
  { value: "003", name: "冰封湖畔" },
  { value: "004", name: "人魂墓地" },
  { value: "005", name: "盡頭之村" },
  { value: "006", name: "風暴荒野" },
  { value: "007", name: "峰亥盧遺跡" },
  { value: "008", name: "魔都羅占布爾克" },
  { value: "009", name: "瘋狂山脈" },
  { value: "014", name: "隨機" },
];

/**
 * 隱藏地圖 —— 官方選單裡**沒有**，但客戶端與伺服器都認得的四張。
 *
 * 官方選單是 `000`~`009` 加上 `014`（隨機），中間的 010~013 整段跳過。但那四張
 * 是**真的地圖**，不是空號：
 *
 * ```
 *   loadBackgroundAssets(pack, room)   ← 客戶端自己組路徑，沒有白名單
 *     images/assets/bg/{room_stage}/bg_{room_stage}.webp
 * ```
 *
 * 2026-08-15 直接對資產主機驗過每一個代號（`new Image()` 抓得到就是有）：
 *
 * | 代號 | 圖         | 尺寸        | 說明                              |
 * | ---- | ---------- | ----------- | --------------------------------- |
 * | 009  | 有         | 760×680     | 官方選單裡的最後一張，當對照組    |
 * | 010  | 有         | 760×680     | 魔女山谷                          |
 * | 011  | 有         | 760×680     | 白魔的圓環石陣                    |
 * | 012  | 有         | 760×680     | 烏波斯的黑湖                      |
 * | 013  | 有         | 4560×1360   | 聖域的凱旋門 —— **動畫圖**        |
 * | 014  | 沒有       | —           | 那是「隨機」，伺服器才解析成地圖  |
 *
 * 013 是動畫圖這件事客戶端自己也知道 —— `loadBackgroundAssets` 裡唯一的特例是
 * `"000" != stage && "013" != stage`，那兩個走 `spritesheet`，其餘走 `image`。
 * 一張純粹的空號不會被寫進程式碼的特例分支。

 *
 * ⚠ 還是沒有在這四張上**打完一整場**。背景載得起來是實證，戰鬥流程沒有。
 */
export const HIDDEN_STAGES: readonly { value: string; name: string }[] = [
  { value: "010", name: "魔女山谷" },
  { value: "011", name: "白魔的圓環石陣" },
  { value: "012", name: "烏波斯的黑湖" },
  { value: "013", name: "聖域的凱旋門" },
];

/**
 * 「牌組Cost限制」可以填的值。照抄 `Match.COST_RANGES`。
 *
 * ⚠ 只有 0~5，不是任意數字。它是**容差**（房間對話框寫「± 5」），
 * 而且伺服器用**原版 COST** 判。
 */
export const COST_RANGES: readonly number[] = [0, 1, 2, 3, 4, 5];

/** 官方預設房名（`Match.DEFAULT_NAMES.tcn`）。 */
export const DEFAULT_ROOM_NAME = "請多關照";

export interface ChannelInfo {
  /** `ranked` = 有 BP 排名，`duel` = 一般約戰。 */
  type: string;
  /**
   * COST 階層。**只有 ranked 頻道有**，duel 頻道是 `null`。
   *
   * 2026-08-16 兩個客戶端實測：
   *
   * ```
   *   channels       = {"1":{type:"ranked",cost:[57,66,78]}, "2":{type:"duel"}}
   *   channels_cross = {"3":{type:"ranked",cost:[56,69,71]}, "4":{type:"duel"}}
   * ```
   *
   * ⚠ 2 與 4 **連 `cost` 這個鍵都沒有**，不是空陣列。要拿 duel 頻道的階層得走
   * {@link costTiersFor}。
   */
  cost: (number | null)[] | null;
  /** true = 走 `socket_cross`。 */
  crossplay: boolean;
}

/**
 * 這個頻道的 COST 階層。**duel 頻道借用同一條 socket 上那個 ranked 頻道的。**
 *
 * 玩家給的規則（2026-08-16）：
 *
 * > 頻道二（迪特赫姆）的 COST 限制用亞歷山卓城（頻道一）的 COST，
 * > 頻道四（布萊德克洛伊茲）用峰亥盧遺跡（頻道三）的。**每週二遊戲更新時會跟著變。**
 *
 * ⚠ **不要寫死成 `{2:1, 4:3}`。** 實測的結構比那個對映更基本：`channels` 與
 * `channels_cross` 是兩組**各自成套**的頻道（各走一條 socket），每一組裡有一個
 * ranked 與一個 duel，duel 借用同組 ranked 的階層。照結構推導的話，官方哪天多開
 * 一組頻道也不會壞；寫死編號的話會安靜地拿到另一組的數字 —— 而 1 是
 * `[57,66,78]`、3 是 `[56,69,71]`，**兩組真的不一樣**，拿錯不會報錯只會配錯。
 *
 * ⚠ **每週二會變，所以不能烤進插件裡。** 這支只從客戶端當下的 `channels` 讀，
 * 玩家的客戶端永遠是他實際在玩的那一版。
 */
export function costTiersFor(
  channels: Readonly<Record<string, ChannelInfo>> | null,
  channel: number | null,
): number[] | null {
  if (channels === null || channel === null) return null;
  const mine = channels[String(channel)];
  if (mine === undefined) return null;

  const tiers = (info: ChannelInfo): number[] | null => {
    if (info.cost === null || info.cost === undefined) return null;
    const clean = info.cost.filter((n): n is number => typeof n === "number");
    return clean.length > 0 ? clean : null;
  };

  const own = tiers(mine);
  if (own !== null) return own;

  // 自己沒有 → 找同一組（同一條 socket）的 ranked 頻道。
  for (const info of Object.values(channels)) {
    if (info.crossplay !== mine.crossplay) continue;
    const borrowed = tiers(info);
    if (borrowed !== null) return borrowed;
  }
  return null;
}

export interface CreateRoomOptions {
  name: string;
  /**
   * 對戰地點代號。**3 位數字串**（見 {@link STAGES}），不是地圖名稱。
   * 隨機是 `"014"`。
   *
   * ⚠ **不能傳 `null`。** 原本這裡寫「`null` = 隨機」，那是猜的：實測傳 null
   * 伺服器直接回 `fail: 20`（那個代碼一路被誤判成「AP 不足」）。
   */
  stage: string;
  /** 3vs3 = true */
  multi: boolean;
  friend: boolean;
  /** 房間密碼。約戰一律要有。 */
  pass: string;
  /**
   * 遊戲的「牌組 Cost 限制」—— **是容差不是上限**。開房對話框上寫的是
   * 「牌組Cost限制 ☑ ± 5」，也就是「對手的牌組 COST 要在我的 ±N 之內」。
   * 不限制傳 `null`。
   *
   * ⚠ 伺服器用**原版 COST** 判，跟自訂規則的總和對不上 —— 自訂規則算出來
   * 差很多的兩副牌，在伺服器眼中可能剛好在 ±N 內，反之亦然。
   */
  cost: number | null;
}

export type CreateRoomResult =
  { ok: true; roomId: string | null } | { ok: false; reason: string; fail?: number };

export type JoinRoomResult = { ok: true } | { ok: false; reason: string; fail?: number };

// ---------------------------------------------------------------------------

/**
 * 注入的腳本：在頁面上裝一組 `window.__ulrMatch` 的操作介面。
 *
 * 用 `Runtime.evaluate` 裝就好，**不需要重載** —— Match 場景與 socket 在遊戲
 * 跑起來之後一直都在。
 *
 * ⚠ 每個函式都回傳 JSON 字串而不是物件：序列化失敗的錯誤沒有上下文，
 * 而這支要在真的對戰流程裡跑，出錯時必須看得懂。
 */
export const MATCH_ROOM_INSTALL_EXPRESSION = `(function () {
  "use strict";
  var FLAG = "__ulrMatch";
  // 腳本版本。**改動 listen() 裡任何一行就要 +1**，修 bug 也算。
  //
  // ⚠ 不 +1 的話守衛會認定「已經是這一版」而不重掛，頁面上跑的仍是**有 bug 的
  // 那一支**，而且完全沒有錯誤訊息。2026-08-15 實測踩過：把 st.seq++ 修成
  // b.seq++ 卻沒改版本號，結果清單有內容但 seq 永遠 0，所有「等新推播」全部逾時。
  var VERSION = 7;
  // ⚠ **不要在這裡 early-return。** 改了這支腳本之後，頁面上跑的仍會是舊版，
  // 症狀是「測試綠了但實際跑起來是舊行為」。這個專案在 ws-events 與 patch-ok
  // 上各栽過一次，2026-08-15 這支又栽了一次。
  var reinstall = !!(window[FLAG] && window[FLAG].installed);

  function scene() {
    var sc = window.game && window.game.scene && window.game.scene.keys.Match;
    return sc && sc.scene.isActive() ? sc : null;
  }

  function pickDeck(d) {
    if (!d) return null;
    return { chara: d.chara, charaIndex: d.charaIndex, cost: d.cost };
  }

  /** 拿一份快取 JSON 裡的陣列，拿不到就 null。 */
  function framesOf(cacheKey, field) {
    try {
      var cache = window.game && window.game.cache && window.game.cache.json;
      var asset = cache ? cache.get(cacheKey) : null;
      var rows = asset ? asset[field] : null;
      return rows && rows.length !== undefined ? rows : null;
    } catch (e) {
      return null;
    }
  }

  /** 補零到 3 位。⚠ 要跟 @ulr/rule-schema 的 card-key.ts 一致。 */
  function padIndex(i) {
    var s = String(i);
    while (s.length < 3) s = "0" + s;
    return s;
  }

  /**
   * 牌組的四種規則鍵。
   *
   * charaIndex 就是那份資產 frames 的陣列索引 —— 客戶端自己的
   * Chara.getAsset() 就是這樣查的，所以不需要任何對照表。
   *
   * ⚠⚠ **要看 chara 的前綴決定查哪一份。** 怪物卡的 charaIndex 索引的是
   * mc_asset，拿去查 cc_asset 會撈到一張**存在但完全不相干**的角色卡，而且
   * 不會報錯 —— 自訂規則的總和與配對相容性判定會靜靜地錯掉。
   * 判準抄自客戶端的 Chara.getCharaType()：cc → 角色、mc → 怪物。
   *
   * ⚠ 讀的是 filename **不是 cost**。自訂 COST 的注入會就地改寫同一份快取的
   * cost 欄位，但 filename 沒被動過，所以套過規則的客戶端上讀也是對的。
   * ⚠ 查不到就給 null，不要用空字串頂替 —— 呼叫端要分得出「這格是空的」與
   * 「這格有卡但我讀不到它是誰」，後者算出來的 COST 會少一項。
   */
  function deckKeysOf(d) {
    if (!d || !d.charaIndex || d.charaIndex.length === undefined) return null;
    var cc = framesOf("cc_asset", "frames");
    var mc = framesOf("mc_asset", "frames");
    if (cc === null) return null;

    var characters = [];
    for (var i = 0; i < d.charaIndex.length; i++) {
      var idx = d.charaIndex[i];
      var chara = d.chara && d.chara[i];
      // 前綴認不出來時當角色 —— cc 是絕大多數，而認錯的代價兩邊一樣。
      var frames = typeof chara === "string" && chara.indexOf("mc") === 0 ? mc : cc;
      var f =
        frames !== null && typeof idx === "number" && idx >= 0 && idx < frames.length
          ? frames[idx]
          : null;
      characters.push(f && typeof f.filename === "string" && f.filename !== "" ? f.filename : null);
    }

    // 裝備與事件卡沒有 filename，鍵直接由索引組出來。⚠ 不查資產是刻意的：
    // 索引本身就是鍵，多查一次只會多一種「資產還沒載入 → 鍵變 null」的失敗。
    var equipment = [];
    var weapons = d.weapon && d.weapon.length !== undefined ? d.weapon : [];
    for (var w = 0; w < weapons.length; w++) {
      var wi = weapons[w];
      equipment.push(typeof wi === "number" && wi >= 0 ? "wp" + padIndex(wi) : null);
    }

    var eventCards = [];
    var events = d.eventIndex && d.eventIndex.length !== undefined ? d.eventIndex : [];
    for (var e = 0; e < events.length; e++) {
      var ei = events[e];
      eventCards.push(typeof ei === "number" && ei >= 0 ? "ev" + padIndex(ei) : null);
    }

    return { characters: characters, equipment: equipment, eventCards: eventCards };
  }

  // ⚠ **頻道分兩組，走的是兩條不同的 socket。** 2026-08-15 實測：
  //     sc.channels       = {"1":ranked, "2":duel}   → sc.socket
  //     sc.channels_cross = {"3":ranked, "4":duel}   → sc.socket_cross
  // 3/4 是「跨平台對戰專用頻道」（峰亥盧遺跡、布萊德克洛伊茲）。用錯 socket
  // 的症狀不是報錯，是**安靜地什麼都收不到**：房間清單永遠空的、開房沒有回應。
  function isCross(sc) {
    var t = sc.channels_cross || {};
    return sc.channel !== null && sc.channel !== undefined &&
      Object.prototype.hasOwnProperty.call(t, String(sc.channel));
  }

  /** 目前頻道該用哪一條 socket。 */
  function sock(sc) {
    return isCross(sc) ? sc.socket_cross : sc.socket;
  }

  /** 兩組頻道併成一張表，每筆標好走不走 cross。UI 要靠它列出全部頻道。 */
  function channelTable(sc) {
    var out = {};
    function add(src, cross) {
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        out[k] = { type: src[k].type, cost: src[k].cost || null, crossplay: cross };
      }
    }
    add(sc.channels || {}, false);
    add(sc.channels_cross || {}, true);
    return out;
  }

  // ⚠ 只挑需要的欄位。房間清單一筆就有兩個 avatar 物件，整份搬回 Node
  // 又大又全是跟我們無關的東西。
  function pickRoom(r) {
    return {
      roomId: r.room_id,
      name: r.name,
      playerAName: r.playerA ? r.playerA.name : null,
      playerBName: r.playerB ? r.playerB.name : null,
      pass: r.pass === 1 || r.pass === true,
      deckA: pickDeck(r.deckA),
      deckB: pickDeck(r.deckB)
    };
  }

  // ⚠ 同時留一份**原始**物件。驅動遊戲自己的 room_in() 時要把整個原始
  // 房間物件交回去（它會讀 e.pass），挑過欄位的副本不夠用。
  //
  // ⚠ **重裝必須沿用同一個 state 物件，不能開新的。** 舊版腳本掛在 socket 上的
  // listener 是綁閉包的（那一版還沒改成從 window 查），拆不掉也改不了，它會一直
  // 往舊物件寫。換成新物件的話 window.__ulrMatch.raw 就永遠是空的 ——
  // 症狀是 rooms_snapshot() 看得到那間房、join() 卻回「清單裡沒有這個 room_id」，
  // 因為兩者讀的是同一份資料的兩個副本。2026-08-15 實測在 guest 端踩過。
  var state = (reinstall ? window[FLAG] : null) || { installed: true, byChannel: {} };
  state.installed = true;
  if (!state.byChannel) state.byChannel = {};
  window[FLAG] = state;

  // 讀資料一律走這裡，不要直接用閉包的 state：卸載後再裝會換掉 window[FLAG]，
  // 而還掛在 socket 上的 listener 是往 window[FLAG] 寫的。
  function cur() { return window[FLAG] || state; }

  /**
   * ⚠ **清單一定要按頻道分開存。**
   *
   * 玩家換頻道之後，舊頻道的 listener 還掛在 socket 上（拆不掉：沒留 handler
   * 參考，而 off(ev) 不帶 handler 會把遊戲自己那支一起拆掉）。伺服器也還在
   * 推舊頻道的清單。共用一份 raw 的話兩支會互相蓋，誰最後推播誰贏 ——
   * 2026-08-15 實測：人在頻道 4，raw 裡卻是頻道 2 的房。
   *
   * 後果不是顯示錯而已：findOwnRoom 會從別的頻道的清單裡挑房，然後把
   * **另一個頻道的 room_id** 交給對手。
   *
   * ⚠ 這段在注入腳本的 template literal 裡面 —— **不能用反引號**，
   * 它會讓字串提早結束。
   */
  /**
   * 目前頻道的房間清單 —— **以遊戲自己手上那份為準**。
   *
   * channel_panel.match_room_data 就是大廳正在畫的那份，屬於目前頻道，
   * 而且**不必等推播**。
   *
   * ⚠ 房間清單是「有變動才推」，不是定時推 —— 2026-08-15 實測：頻道裡沒人
   * 開關房時，等 45 秒一次推播都收不到。只靠推播快取的話，剛進頻道的玩家
   * 會看到空清單，而空清單會被誤判成「我沒有自己的房」，直接踩到
   * delete_room 是頻道層級的那個坑。
   *
   * 推播 listener 留著只為了 seq（有沒有變動過），資料本身不靠它。
   */
  function panelRooms(sc) {
    var d = sc.channel_panel && sc.channel_panel.match_room_data;
    return Array.prototype.slice.call(d && d.length !== undefined ? d : []);
  }

  /** 有沒有讀得到遊戲那份清單。讀不到才退回推播快取。 */
  function hasPanel(sc) {
    var d = sc.channel_panel && sc.channel_panel.match_room_data;
    return !!(d && d.length !== undefined);
  }

  function bucket(channel) {
    var st = cur();
    if (!st.byChannel) st.byChannel = {};
    var key = String(channel);
    if (!st.byChannel[key]) st.byChannel[key] = { raw: [], rooms: [], seq: 0 };
    return st.byChannel[key];
  }

  // 房間清單是推播的，先把最後一次收到的留著。
  function listen(sc) {
    // ⚠ 記住**註冊當下**的頻道。回呼時再讀 sc.channel 會拿到玩家後來換到的
    // 那個，於是把舊頻道的清單寫進新頻道的格子裡 —— 正是要修的那個 bug。
    var chan = sc.channel;
    var ev = "channel" + chan + "_room";
    // ⚠ 掛在**該頻道自己那條** socket 上。掛錯的話一筆推播都收不到。
    var so = sock(sc);
    // 掛過的記在 socket 上 —— state 會被重裝換掉，socket 不會。
    //
    // ⚠ 記的是**版本**不是 true。舊版的 listener 綁閉包，只能再掛一支新的蓋過去
    // （拆不掉：當時沒留 handler 參考，而 socket.off(ev) 不帶 handler 會把遊戲
    // 自己那支一起拆掉，房間列表就不會畫了）。多掛一支是安全的 —— 每一支都往
    // window[FLAG] 寫同一份快照，只是重複做一次。
    if (!so.__ulrListened) so.__ulrListened = {};
    if (so.__ulrListened[ev] === VERSION) return;
    so.__ulrListened[ev] = VERSION;
    so.on(ev, function (list) {
      // ⚠ 從 window 查，**不要用閉包裡的 state** —— 重裝之後舊的 listener
      // 還掛在 socket 上，綁閉包的話它會一直往舊物件寫，新的永遠收不到推播。
      var st = window[FLAG];
      if (!st) return;
      var b = bucket(chan);
      try {
        b.raw = Array.prototype.slice.call(list || []);
        b.rooms = Array.prototype.map.call(b.raw, pickRoom);
        // ⚠ 每次推播 +1。呼叫端要靠它分辨「這份清單是不是我開房之後才來的」——
        // 用舊快取會把**上一場的 room_id** 交給對手，而伺服器會正確地回
        // fail:9（那間房早就配對過了）。2026-08-15 實測踩過。
        //
        // ⚠ 加在**這個頻道那一格**上，不是根物件。加錯地方的症狀很安靜：
        // 清單有內容但 seq 永遠 0，於是每一次「等新推播」都會逾時。
        b.seq++;
      } catch (e) {
        b.raw = [];
        b.rooms = [];
      }
    });
  }

  state.context = function () {
    var sc = scene();
    if (sc === null) {
      return JSON.stringify({
        hasId: false, channel: null, channels: null, crossplay: false,
        deckNow: null, deckCost: null, deckKeys: null,
        playerName: null, isMatching: false, inMatch: false
      });
    }
    if (sc.channel !== undefined && sc.channel !== null && sock(sc)) listen(sc);
    var deck = sc["deck" + sc.deck_now];
    return JSON.stringify({
      hasId: typeof sc.id === "string" && sc.id.length > 0,
      channel: sc.channel === undefined ? null : sc.channel,
      channels: channelTable(sc),
      crossplay: isCross(sc),
      deckNow: sc.deck_now === undefined ? null : sc.deck_now,
      // ⚠ 這是**伺服器用原版 COST 算的**總和，不是自訂規則的總和。改寫 cc_asset
      // 不會動到它（實測：改寫後三張加起來 48，這個欄位仍是 49）。
      deckCost: deck && typeof deck.cost === "number" ? deck.cost : null,
      // 自訂規則的總和要靠這個算 —— 見 deckKeysOf() 上面那段。
      deckKeys: deckKeysOf(deck),
      playerName: sc.player ? sc.player.name : null,
      isMatching: !!(sc.channel_panel && sc.channel_panel.is_matching),
      inMatch: true
    });
  };

  // ⚠ 只回**目前頻道**那一份。換頻道之後舊頻道的 listener 還在推，共用一份的
  // 話會拿到別的頻道的房。剛換過去、還沒收到推播時 seq 是 0 —— 呼叫端要靠它
  // 分辨「這個頻道沒有房」跟「還不知道」。
  state.rooms_snapshot = function () {
    var sc = scene();
    if (sc === null || sc.channel === null || sc.channel === undefined) {
      return JSON.stringify({ seq: 0, rooms: [] });
    }
    var b = bucket(sc.channel);
    // 遊戲那份是即時的；讀不到才退回推播快取。
    if (hasPanel(sc)) {
      return JSON.stringify({
        seq: b.seq, live: true,
        rooms: Array.prototype.map.call(panelRooms(sc), pickRoom)
      });
    }
    return JSON.stringify({ seq: b.seq, live: false, rooms: b.rooms || [] });
  };

  state.create = function (optsJson) {
    var o = JSON.parse(optsJson);
    var sc = scene();
    if (sc === null) return Promise.resolve(JSON.stringify({ ok: false, reason: "不在 Match 畫面" }));
    listen(sc);

    var so = sock(sc);
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(JSON.stringify(v)); } }

      so.once("match_room_error", function (e) {
        finish({ ok: false, reason: "伺服器拒絕開房", fail: e && e.fail });
      });
      so.once("match_waiting", function () {
        // 房開好了。room_id 要等下一次房間清單推送才知道 —— 這裡先回成功，
        // 由 Node 端輪詢 rooms_snapshot() 找自己那間。
        finish({ ok: true, roomId: null });
      });

      try {
        so.emit("match_room_make", sc.id, sc.channel, o.name, o.stage,
          o.multi, o.friend, o.pass, o.cost, sc.deck_now);
      } catch (e) {
        finish({ ok: false, reason: String((e && e.message) || e) });
      }
      setTimeout(function () { finish({ ok: false, reason: "等 match_waiting 逾時" }); }, 15000);
    });
  };

  // 進房：驅動遊戲自己的 room_in()，不自己 emit。
  // ⚠ 自己 emit 會漏掉那個函式裡做的事 —— 最關鍵的是 room_id 其實是從
  // channel_panel.room_select.room_id 讀的，不是參數。詳見這支的檔頭。
  // 密碼那關遊戲會開輸入框等玩家打字，所以暫時把 sc.password 換掉，叫完再還原。
  // ⚠ 參數是**一包 JSON 字串**，跟 create() 一樣，進來第一件事就是 parse。
  // 兩個字串參數直接收 embedJson() 的輸出會拿到「連引號一起」的值
  // （embedJson 產的是 JSON 的字面值，設計上就是要 parse 一次）——
  // 症狀是 rooms_snapshot() 看得到那間房、join() 回「清單裡沒有這個 room_id」，
  // 因為比對是拿「含引號的 abc」去比「abc」。密碼同樣會多帶一對引號。
  // 2026-08-15 實測踩過，一路被誤判成「快取有兩份」。
  state.join = function (payloadJson) {
    var p = JSON.parse(payloadJson);
    var roomId = p.roomId;
    var pass = p.pass;
    var sc = scene();
    if (sc === null) return Promise.resolve(JSON.stringify({ ok: false, reason: "不在 Match 畫面" }));

    // ⚠ 只在**目前頻道**那一份裡找。找到別的頻道的房也進不去，而且會把錯的
    // room_id 當成有效的。優先用遊戲那份即時清單。
    var raw = hasPanel(sc) ? panelRooms(sc) : bucket(sc.channel).raw || [];
    var entry = null;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && raw[i].room_id === roomId) { entry = raw[i]; break; }
    }
    if (entry === null) {
      return Promise.resolve(JSON.stringify({ ok: false, reason: "房間清單裡沒有這個 room_id" }));
    }
    if (!sc.channel_panel) {
      return Promise.resolve(JSON.stringify({ ok: false, reason: "還沒進頻道（沒有 channel_panel）" }));
    }

    var so = sock(sc);
    return new Promise(function (resolve) {
      var done = false;
      var originalPassword = sc.password;

      function finish(v) {
        if (done) return;
        done = true;
        try { sc.password = originalPassword; } catch (e) {}
        resolve(JSON.stringify(v));
      }

      so.once("match_room_error", function (e) {
        finish({ ok: false, reason: "進房被拒", fail: e && e.fail });
      });
      so.once("duel_standby", function () { finish({ ok: true }); });

      try {
        // 遊戲從這裡拿 room_id —— 這是自己 emit 時漏掉的那一塊。
        sc.channel_panel.room_select = entry;
        // 密碼輸入框換成直接回傳 token。
        sc.password = function () { return Promise.resolve(pass); };
        // ⚠ 第一個參數是 crossplay，要跟頻道對上。頻道 3/4（峰亥盧遺跡、
        // 布萊德克洛伊茲）是跨平台頻道，傳 false 會讓遊戲拿錯 socket。
        sc.room_in(isCross(sc), entry);
      } catch (e) {
        finish({ ok: false, reason: String((e && e.message) || e) });
      }
      setTimeout(function () { finish({ ok: false, reason: "等 duel_standby 逾時" }); }, 25000);
    });
  };

  // 收掉自己開的房。取消配對時一定要叫，否則清單上會留一堆空房。
  //
  // ⚠ delete_room 只吃 channel、**不吃 room_id** —— 它收掉的是你在那個頻道的
  // 房，而玩家可能同時有兩間（手動開了一間，插件又開了一間）。2026-08-15 實測：
  // 按一次取消，兩間一起消失。所以插件開房之前要先確認玩家沒有自己的房，
  // 否則「取消配對」會順手把他手動開的那間也收掉。
  state.cancel = function () {
    var sc = scene();
    if (sc === null) return "不在 Match 畫面";
    try {
      sock(sc).emit("delete_room", sc.channel);
      if (sc.channel_panel) {
        sc.channel_panel.is_matching = false;
        if (sc.channel_panel.refresh_rooms) sc.channel_panel.refresh_rooms();
      }
      return "ok";
    } catch (e) { return String((e && e.message) || e); }
  };

  return reinstall ? "reinstalled" : "installed";
})()`;

/** 拆掉。留著也無害（只是幾個函式），但換版本時要能清乾淨。 */
export const MATCH_ROOM_UNINSTALL_EXPRESSION = `(function () {
  try { delete window.__ulrMatch; return "ok"; } catch (e) { return String(e); }
})()`;

// ---------------------------------------------------------------------------

/** 產生「開房」的呼叫。參數走 `embedJson`，永遠不會被當程式碼執行（§12）。 */
export function buildCreateRoomExpression(options: CreateRoomOptions): string {
  return `window.__ulrMatch.create(${embedJson(options)})`;
}

/**
 * 產生「進房」的呼叫。
 *
 * ⚠ 一定要包成**一包 JSON** 傳，不要拆成兩個字串參數。`embedJson` 產出的是
 * 「JSON 的 JS 字面值」，頁面端不 parse 就會拿到多一對引號的值。
 */
export function buildJoinRoomExpression(roomId: string, pass: string): string {
  return `window.__ulrMatch.join(${embedJson({ roomId, pass })})`;
}

/**
 * 從房間清單裡找出「我自己開的那一間」。
 *
 * ⚠ 靠 `playerA.name` 比對，不是靠房名 —— 房名是玩家自訂的，撞名就會拿到
 * 別人的 roomId 然後把對手送進陌生人的房間。一個玩家同時只能開一間房，
 * 所以名字是可靠的。
 *
 * ⚠ **房名不能拿來當識別碼的另一個理由**：房名會出現在公開清單上，而我們
 * 唯一能用來識別的祕密是 token —— 那是密碼，貼上去就等於沒有密碼。
 */
export function findOwnRoom(
  rooms: readonly RoomEntry[],
  playerName: string,
  expectedName?: string,
): RoomEntry | null {
  let mine = rooms.filter((r) => r.playerAName === playerName);

  // ⚠ 一個玩家可能同時有不只一間房（手動開過一間又用插件開了一間）。
  // 2026-08-15 實測就踩到：抓到的是玩家手動開的那間，於是把它的 pass 欄位
  // 當成插件開的那間的，得出「密碼沒生效」這個完全錯誤的結論。
  //
  // 先用房名縮小，再排掉已經有對手的（那間一定不是我們剛開的）。
  // ⚠ 指定了房名就**只認那個名字**，找不到一律回 null。原本這裡是
  // 「找不到就退回全部」，結果在清單還沒更新時挑到玩家的舊房，把上一場的
  // room_id 交了出去。退讓的預設值在這裡是危險的。
  if (expectedName !== undefined) {
    mine = mine.filter((r) => r.name === expectedName);
  }
  const empty = mine.filter((r) => r.playerBName === null);
  if (empty.length > 0) mine = empty;

  // 還是分不出來就回 null。猜錯會把對手送進別的房間，寧可讓呼叫端等下一次推播。
  return mine.length === 1 ? (mine[0] ?? null) : null;
}
