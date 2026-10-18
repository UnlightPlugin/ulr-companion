// 分頁結構、外殼、狀態列與內容區的共用工具（其他檔都靠這支先載入）。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// =====================================================================
// 分頁結構
//
// ⚠ 大分頁**照里程碑分**，不是照實作狀態分。牌組／渦／獎勵／任務四個
// 這一輪不出現（範圍決定），但加回來只要在這裡多一筆 —— 畫面的其餘部分
// 完全不必動。
// =====================================================================
const TABS = [
  {
    id: "battle",
    label: "戰鬥",
    subs: [
      { id: "ready", label: "準備" },
      { id: "seconds", label: "秒數上限" },
      // 加速的引擎與協商都做好了，但連預告頁都拿掉了（玩家 2026-10-04）：
      // 戰鬥長度是伺服器排程的，加速客戶端動畫幾乎沒效果。
      { id: "count", label: "記牌", todo: true },
      { id: "replay", label: "牌譜", todo: true },
    ],
  },
  {
    id: "deck",
    label: "牌組",
    subs: [
      // 牌組替換排在等候套用前面：後者只在插件模式有意義。
      { id: "deckmode", label: "牌組替換" },
      { id: "apply", label: "等候套用" },
      { id: "chara", label: "人物篩選" },
    ],
  },
  {
    id: "vortex",
    label: "渦",
    subs: [
      { id: "vrank", label: "獎勵標記" },
      { id: "vreward", label: "結算通知" },
      { id: "vitem", label: "物品捷徑" },
      { id: "vfound", label: "發現渦" },
      { id: "vfeed", label: "渦通報" },
    ],
  },
  // 迪特赫姆：只在迪城才有作用的東西（玩家 2026-09-26：在迪城和小號互刷賺 GEM）。
  // 隱藏地圖是從牌組搬過來的 —— 它改的是迪城「創建對戰房間」的下拉。
  {
    id: "diet",
    label: "迪特赫姆",
    subs: [
      { id: "hidden", label: "隱藏地圖" },
      { id: "ditem", label: "物品捷徑" },
      { id: "gemup", label: "GEM UP" },
      // 投降（玩家 2026-10-05）：不確認只在迪城；鈕放外面渦、亞城也算
      // 2026-10-06：直接投降時「你投降了」框不跳、結算畫面略過，直接到獎勵遊戲
      { id: "surrender", label: "投降" },
    ],
  },
  {
    id: "bonus",
    label: "獎勵",
    subs: [
      { id: "bitem", label: "物品捷徑" },
      // 玩家 2026-10-06：不用先按下一個卡片就能選 High／Low
      { id: "bhighlow", label: "High Low" },
      // 玩家 2026-10-11：照勾選的目標自己爬，勝場、敗場各一組
      { id: "bclimb", label: "自動爬星" },
    ],
  },
  {
    id: "quest",
    label: "任務",
    subs: [
      { id: "qitem", label: "物品捷徑" },
      { id: "chest", label: "寶箱標註" },
      // 玩家 2026-10-08：寶箱面板與任務結束的確認框，自動按 OK 或不顯示（兩組分開）
      { id: "qpanel", label: "確認框" },
    ],
  },
  // 模組：改的是玩家自己畫面上的美術，不動規則、不動對手看到的東西。
  { id: "mods", label: "模組", subs: [{ id: "cards", label: "卡面替換" }] },
  // 自訂COST：原本在牌組底下的五格，獨立出來（玩家 2026-09-26）。
  {
    id: "rule",
    label: "自訂COST",
    subs: [
      // ⚠ **對戰地點排第一。** 自動配對本身搬回遊戲裡了（迪城大廳那顆
      // 「快速比賽」），托盤這一格只剩「這一場開在哪」—— 而那是玩家會
      // 回來調的東西，規則選一次就不太會再動。
      { id: "match", label: "對戰地點" },
      { id: "cost", label: "Cost 表" },
      // 編輯的三頁排在 Cost 表後面，那是實際的動線：先選一份規則
      // （Cost 表）→ 改它 → 拿去配對。
      //
      // ⚠ 三頁改的是**同一個檔案的三半**，分開是因為形狀差太多：
      // 1186 個數字格 / 十幾段區間 / 一疊文字欄位。
      { id: "costedit", label: "編輯 COST" },
      { id: "ruleedit", label: "編輯規則" },
      { id: "ruledesc", label: "編輯描述" },
    ],
  },
  {
    id: "settings",
    label: "設置",
    subs: [
      { id: "link", label: "連線" },
      // 用瀏覽器玩的整套：帶除錯埠的瀏覽器（按鈕／桌面捷徑／手動教學）＋
      // Steam 登入擴充＋登入。放在連線底下：它跟「怎麼開遊戲」是同一件事。
      { id: "web", label: "網頁版" },
      { id: "startup", label: "啟動" },
      { id: "log", label: "記錄" },
      // 更新併進關於（玩家 2026-10-04）：那一頁只有版本號與一段說明。
      { id: "about", label: "關於" },
      // ⚠ **「配置」是整個介面裡優先級最低的一格，而且預設看不見。**
      //
      // 它管的是多開（一個視窗管一個遊戲客戶端，要管兩個就開兩份）。
      // 預設的使用者不知道有這回事，也不需要知道 —— 裝完就是一個視窗，
      // 埠、中間人埠、「開新實例」對他全都是雜訊。
      //
      // 要打開它得自己去 關於 那頁最底下勾「進階：同時管兩個遊戲客戶端」。
      // 排在關於後面是刻意的：找得到的人本來就是在找它。
      { id: "profiles", label: "配置", advanced: true },
    ],
  },
];

/** 這個大分頁現在該顯示哪幾格。進階的那幾格只有玩家自己打開才出現。 */
function subsOf(t) {
  const multi = snap?.store?.multiProfile === true;
  return t.subs.filter((s) => !s.advanced || multi);
}

let tab = "battle";
let sub = "ready";
let snap = null;
/** 拖動滑桿時不要被推播的狀態蓋回去，不然會一直跳。 */
let dragging = false;
/** 正在編輯某個欄位時同理 —— 每次推播重畫會把游標踢掉。 */
let editing = null;

const $ = (id) => document.getElementById(id);

/**
 * 使用者正在內容區的某個欄位裡打字／挑選項嗎。
 *
 * ⚠⚠ **重畫是換掉 `#content` 的 innerHTML** —— 正在打字的那個輸入框會
 * 連同游標、選取範圍、還有打到一半的字一起消失。所以每一條會重畫的路徑
 * 都要先問這一句。
 *
 * 這支存在的理由是一個實際的 bug：配對頁的輪詢有擋（它自己查
 * `document.activeElement`），但**狀態推播那條沒有** —— 而推播是連線
 * 心跳、對戰狀態、記錄檔每幾秒就來一次的東西。症狀是「房名打到一半游標
 * 就不見了」，而玩家完全不會把它跟「插件在更新狀態」連在一起。
 *
 * ⚠ 用 `document.activeElement` 而不是自己記「誰在被編輯」（原本那個
 * `editing` 變數）：每個頁面都要記得設它，而漏掉的頁面**看起來完全正常**
 * 直到有人在上面打字。問瀏覽器就不會漏。
 */
function isEditing() {
  const el = document.activeElement;
  if (!el || typeof el.closest !== "function" || !el.closest("#content")) return false;
  return /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable === true;
}

/**
 * 打字時錯過的重畫，等焦點離開再補一次。
 *
 * ⚠ 沒有這一段的話畫面會**停在玩家開始打字的那一刻** —— 配對狀態、房間
 * 清單、連線狀態全部凍在那裡，而他完全不知道那是因為自己游標還在輸入框裡。
 *
 * ⚠ 只掛一個（`pendingCatchUp` 這道閘）：每打一個字掛一個 listener 的話，
 * 打完二十個字就會連續重畫二十次。
 */
let pendingCatchUp = false;
function scheduleCatchUp() {
  if (pendingCatchUp) return;
  pendingCatchUp = true;
  document.addEventListener(
    "focusout",
    () => {
      pendingCatchUp = false;
      // ⚠ 要等一拍。`focusout` 時焦點還沒落到下一個元素上，立刻重畫的話
      // 「從房名 tab 到地點」會被判定成沒人在編輯，於是把玩家正要用的
      // 那個下拉選單也換掉。
      setTimeout(() => {
        if (isEditing() || dragging) return;
        editing = null;
        renderBody();
      }, 150);
    },
    { once: true },
  );
}
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// =====================================================================
// 外殼
// =====================================================================
function renderChrome() {
  $("tabs").innerHTML = TABS.map(
    (t) => `<button data-tab="${t.id}" aria-selected="${t.id === tab}">${esc(t.label)}</button>`,
  ).join("");
  const current = TABS.find((t) => t.id === tab);
  $("side").innerHTML = subsOf(current)
    .map(
      (s) =>
        `<button data-sub="${s.id}" class="${s.todo ? "todo" : ""}" aria-selected="${
          s.id === sub
        }">${esc(s.label)}</button>`,
    )
    .join("");
}

$("tabs").addEventListener("click", (e) => {
  const id = e.target.closest("button")?.dataset.tab;
  if (!id || id === tab) return;
  tab = id;
  sub = subsOf(TABS.find((t) => t.id === id))[0].id;
  renderChrome();
  renderBody();
});

$("side").addEventListener("click", (e) => {
  const id = e.target.closest("button")?.dataset.sub;
  if (!id || id === sub) return;
  sub = id;
  webMsg = null;
  renderChrome();
  renderBody();
});

// =====================================================================
// 狀態列
// =====================================================================
const LINK_TEXT = {
  // ⚠ idle 不是錯誤，是「還不需要連」。跟 offline 分開講是刻意的 ——
  // 混成同一句的話，玩家在大廳看到「沒連上中間人」會以為壞了。
  idle: "還沒進對戰",
  offline: "沒連上 Cloudflare Workers",
  solo: "還沒配到對手",
  paired: "已配到對手",
  incompatible: "⚠ 版本不合，已退回單邊",
};

/**
 * 客戶端種類怎麼寫。**瀏覽器一律用它自己的名字，不寫「網頁版」。**
 *
 * 理由不是好看：玩家可以同時開 Chrome 與 Edge 各掛一個帳號（兩者有各自
 * 的 profile 目錄與埠），而配置表上兩列都叫「網頁版」的話，他分不出正在
 * 改的是哪一邊的設定 —— 而改錯的後果（接到另一個帳號的遊戲）在畫面上
 * 完全看不出來。措辭與 `profiles-core.ts` 的 `clientLabel()` 對齊。
 *
 * 認不出來的值就原樣顯示，不要掰成「桌面版」—— 那會在未來多一種客戶端時
 * 變成一句錯的話。
 */
const KIND_TEXT = { desktop: "桌面版", chrome: "Chrome", edge: "Edge" };
const kindText = (kind) => KIND_TEXT[kind] ?? kind ?? "—";

/**
 * 對手是 NPC 的那幾種 rule（`status.rule`）。認不出來就不特別講。
 *
 * ⚠ 這幾種模式底下**準備與秒數整組不生效**（2026-08-09），所以每一處
 * 顯示「生效中／已配對」的地方都要先問過它，否則 UI 會宣稱一個不存在的保護。
 */
const NPC_RULE_TEXT = { quest: "任務", raid: "渦", event: "活動" };

function renderFooter() {
  const st = snap?.status;
  const p = snap?.profile;
  /**
   * ⚠ **右上角只寫「這個視窗是誰」，不寫埠、不寫中間人。**
   *
   * 那兩個東西以前掛在這裡，但它們回答的不是玩家會問的問題。埠是實例身分
   * （玩家現在一律用 `--remote-debugging-port=0`，那個數字根本沒有人在聽），
   * 中間人是預設值就會動的東西 —— 兩個都只會讓人停下來想「我是不是漏設了
   * 什麼」。要查的人在 設置 › 連線 找得到。
   *
   * 配置名稱**也只在多開打開時**才有意義：只有一個客戶端的人，那就是一個
   * 他沒取過的名字。
   */
  const multi = snap?.store?.multiProfile === true;
  $("ver").textContent = snap?.version ? `v${snap.version}` : "";
  $("who").textContent = p && multi ? p.name : "";
  // 只有一份實例時這一格留空 —— 旁邊那顆燈就是全部的資訊，
  // 補一個玩家沒取過的名字只是讓狀態列多一個要解讀的東西。
  $("fProfile").textContent = p && multi ? p.name : "";
  $("dot").className =
    "dot " + (!st || !st.connected ? "" : st.link === "paired" ? "paired" : "solo");
  /**
   * ⚠ **狀態列不只講對戰。**（玩家 2026-10-04：插件功能很多）
   *
   *   第一格  燈號就是連線狀態（「等遊戲／已接上」那一格拿掉了，玩家 2026-10-04）
   *   第二格  握手 —— **只在跟真人對戰時出現**。其他時候它只會寫「還沒進對戰」，
   *           在大廳、渦房、任務裡看到這句只會讓人以為少做了什麼
   *   最後一格 插件最近做的一件事（任何功能的記錄），點一下看完整記錄
   */
  const pvpNow = st?.connected === true && st.armed && st.pvp === true;
  $("fLink").style.display = pvpNow ? "" : "none";
  $("fLink").textContent = pvpNow ? (LINK_TEXT[st.link] ?? st.link) : "";
  // 記錄有時一則好幾行（例外的堆疊），狀態列只放第一行；完整的在 title 與記錄頁。
  const lastLog = (snap?.log ?? []).at(-1) ?? "";
  const last = st?.error ? "⚠ " + st.error : lastLog.split("\n")[0] || "—";
  $("fLast").textContent = last;
  $("fLast").title = st?.error ? "⚠ " + st.error : lastLog || "";
}

// =====================================================================
// 內容
// =====================================================================
const PAGES = {};

/** 這一格在 TABS 裡的定義。找不到回 null。 */
function subDef(tabId, subId) {
  const t = TABS.find((x) => x.id === tabId);
  return t?.subs.find((s) => s.id === subId) ?? null;
}

/**
 * 沒有對應 PAGES 條目時畫什麼。
 *
 * ⚠ **絕對不要退回空字串。** 空白頁不會報錯、不會出現在 log 裡，看起來
 * 就只是「這個功能壞了」—— 配置頁與五個預告頁就是這樣安靜地消失了很久
 * （分頁註冊了、CSS 與事件都在，只有 render 函式沒寫）。
 */
function missingPage(tabId, subId) {
  const def = subDef(tabId, subId);
  const label = def?.label ?? subId;
  if (def?.todo) {
    // 知道卡在哪就講明白（見 todoPage 的註解：不要只寫「敬請期待」）。
    return todoPage(
      label,
      def.why ?? "這個功能還沒做。",
      def.items ?? [
        "分頁先放著是為了讓你知道規劃了什麼，不是它壞了。",
        "做好之後這一頁會換成真正的內容。",
      ],
    );
  }
  // 不是預告卻沒有頁面 —— 那是真的漏了，要講出來而不是裝沒事。
  return (
    head(label, "", "缺頁") +
    `<div class="card"><div class="hint warn" style="margin-top:0">
       ⚠ 這一頁還沒接上（<code>${esc(tabId)}/${esc(subId)}</code> 沒有對應的畫面）。
       這是插件的問題，不是你的操作。
     </div></div>`
  );
}

function renderBody() {
  // ⚠ 重畫會把整個 #content 換掉，釘住的那顆 ⓘ 跟著被丟掉 —— 氣泡是
  // fixed 的，不收的話會變成一段浮在半空中、指著已經不存在的東西的說明。
  hideTip();
  const fn = PAGES[`${tab}/${sub}`];
  $("content").innerHTML = fn ? fn() : missingPage(tab, sub);
  // 隱藏地圖頁的資料不在 snapshot 裡，開著的時候才輪詢。
  // ⚠ 對戰地點那一頁**不輪詢**了（WP-18）：它只剩一格設定，而那一格
  // 跟著快照走 —— 一個純設定頁沒有理由每三秒去戳一次遊戲。
  if (onStagePage()) startStagePolling();
  else stopStagePolling();
  // 渦那兩頁同理：狀態要跟遊戲要，開著才輪詢。
  if (onRaidPage()) startRaidPolling();
  else stopRaidPolling();
  // 任務那兩頁同理。
  if (onQuestPage()) startQuestPolling();
  else stopQuestPolling();
  // 迪特赫姆的物品捷徑／GEM UP 同理。
  if (onDietPage()) startDietPolling();
  else stopDietPolling();
  // 獎勵的物品捷徑同理。
  if (onBonusPage()) startBonusPolling();
  else stopBonusPolling();
  // 卡面替換同理（資料夾內容＋遊戲那端換了幾張）。
  if (onModsPage()) startModsPolling();
  else stopModsPolling();
}

/**
 * 「按上去才看得到」的那一段長話 —— 一顆 ⓘ，內容在 `data-tip` 裡。
 *
 * ⚠⚠ **這是給細節找地方住的，不是給重要的話用的。** 玩家可能永遠不會把
 * 滑鼠移上去，所以任何「不知道就會做錯事」的話都必須留在畫面上。ⓘ 裡放的
 * 是「知道了會更好，但不知道也不會出事」的那一種。
 *
 * ⚠⚠ **不要換回瀏覽器原生的 `title`。** 它看起來比較省事（自己處理邊界、
 * 換行），但它的顯示延遲大約一秒、由作業系統決定、網頁改不了，而且滑鼠
 * 只要移動一格就從頭計時 —— 手會抖的人等於永遠看不到那段說明
 * （2026-09-09 回報）。所以這裡自己畫一顆：滑上去**當下**就出現，
 * 點一下釘住。邊界問題由 `showTip()` 自己夾。
 *
 * ⚠ 說明文字放在 `data-tip`，同時也放進 `aria-label` —— 螢幕閱讀器要唸的
 * 是那段說明，不是「說明」兩個字。
 */
function info(text) {
  const t = esc(text);
  return `<span class="info" data-tip="${t}" aria-label="${t}" role="button" tabindex="0">ⓘ</span>`;
}

// ---------------------------------------------------------------------
// ⓘ 的說明氣泡
//
// 兩種開法，缺一不可：
//   滑上去  → 當下就出現（不是原生 title 那個一秒）
//   點一下  → **釘住**，滑鼠移開也不收
//
// ⚠ 釘住這件事不是額外的貼心，是這顆東西能不能用的關鍵：目標只有一個
// 字元寬，手一抖就滑出去，純靠 hover 的話說明會在讀到一半時消失。
// ---------------------------------------------------------------------

/** 現在釘住的是哪一顆 ⓘ。`null` = 沒釘（那時候滑鼠移開就收）。 */
let tipPinned = null;

function tipBox() {
  let el = document.getElementById("tip");
  if (el === null) {
    el = document.createElement("div");
    el.id = "tip";
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

/**
 * 把氣泡開在某顆 ⓘ 底下。
 *
 * ⚠ **座標要夾在視窗內。** 這幾顆 ⓘ 有的貼著右邊界，不夾的話氣泡會有一半
 * 在畫面外，而那正是「自己做的浮層總有一天被切掉」的那個坑 —— 夾一次就
 * 沒有了。底下放不下就改放上面。
 */
function showTip(el) {
  const text = el.dataset.tip ?? "";
  if (text === "") return;
  const box = tipBox();
  box.textContent = text;
  box.hidden = false;

  // ⚠ 先量再擺：要知道它多高多寬才決定放哪，而那要等它有內容且可見。
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(r.left, window.innerWidth - b.width - pad));
  const below = r.bottom + 6;
  const top = below + b.height + pad > window.innerHeight ? r.top - b.height - 6 : below;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(Math.max(pad, top))}px`;
}

function hideTip() {
  const box = document.getElementById("tip");
  if (box !== null) box.hidden = true;
  if (tipPinned !== null) tipPinned.classList.remove("on");
  tipPinned = null;
}

// 滑上去就開。⚠ 用 mouseover/mouseout（會冒泡）而不是 mouseenter ——
// 內容每次重畫都是新的節點，逐個掛 listener 的話重畫一次就全掉了。
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.(".info");
  if (el === null || el === undefined) return;
  if (tipPinned !== null && tipPinned !== el) return; // 釘住的優先
  showTip(el);
});
document.addEventListener("mouseout", (e) => {
  const el = e.target.closest?.(".info");
  if (el === null || el === undefined) return;
  if (tipPinned !== null) return; // 釘住了就不收
  const box = document.getElementById("tip");
  if (box !== null) box.hidden = true;
});

// 點一下釘住／再點一下放開。點別的地方也放開。
document.addEventListener("click", (e) => {
  const el = e.target.closest?.(".info");
  if (el === null || el === undefined) {
    if (tipPinned !== null) hideTip();
    return;
  }
  if (tipPinned === el) {
    hideTip();
    return;
  }
  if (tipPinned !== null) tipPinned.classList.remove("on");
  tipPinned = el;
  el.classList.add("on");
  showTip(el);
});

// 鍵盤：Tab 到它就開，Esc 收起來。
document.addEventListener("focusin", (e) => {
  const el = e.target.closest?.(".info");
  if (el !== null && el !== undefined) showTip(el);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideTip();
});
// ⚠ 視窗一捲動氣泡就要收 —— 它是 fixed 的，捲動時不會跟著那顆 ⓘ 走，
// 留著會變成一段浮在半空中、指著別的東西的說明。
window.addEventListener("scroll", () => hideTip(), true);
window.addEventListener("resize", () => hideTip());

function head(title, lede, badge) {
  return (
    `<h2>${esc(title)}${badge ? `<span class="badge">${esc(badge)}</span>` : ""}</h2>` +
    `<div class="rule"></div>` +
    (lede ? `<p class="lede">${lede}</p>` : "")
  );
}

/** 未實作的頁長什麼樣。**要講清楚卡在哪**，不是只寫「敬請期待」。 */
function todoPage(title, why, items) {
  return (
    head(title, "", "未實作") +
    `<div class="todo-box"><h3>${esc(why)}</h3><ul>` +
    items.map((i) => `<li>${i}</li>`).join("") +
    `</ul></div>`
  );
}
