// 自訂COST › Cost 表／編輯 COST／編輯規則／編輯描述／對戰地點。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 自訂COST › Cost 表 ---------------------------------------------------
/**
 * 自訂 COST。
 *
 * ⚠ 這一頁最重要的一件事是**講清楚「選了規則」跟「畫面上真的變了」是
 * 兩回事**。注入走 `addScriptToEvaluateOnNewDocument`，只對之後載入的
 * document 生效 —— 玩家選完規則盯著牌組畫面看不到變化是**正常的**，
 * 而如果 UI 只寫「已啟用」，他會以為插件壞了然後去重裝。
 */
const COST_PHASE_TEXT = {
  off: "未啟用（顯示原版數字）",
  pending: "已裝上，遊戲載入卡片資料時套用",
  applied: "生效中",
  error: "注入失敗",
};

/**
 * 罰則的狀態跟價格分開。
 *
 * ⚠ 這不是多此一舉：罰則走 `Deck.prototype.getCost`，<b>立刻生效</b>；
 * 價格改的是快取裡的資料，要等資料載進來。合成一句話一定會對其中一邊說謊。
 */
const COST_PENALTY_TEXT = {
  off: "用遊戲原本的（7~13 罰 5、14 以上罰 10）",
  applied: "生效中",
  error: "注入失敗",
};

/** 壓 C 區間寫成人話：`7 ~ 13 → +5`、`14 以上 → +10`。 */
function bandText(b) {
  const range =
    b.maxGap === null
      ? `${b.minGap} 以上`
      : b.minGap === b.maxGap
        ? `${b.minGap}`
        : `${b.minGap} ~ ${b.maxGap}`;
  return `差距 ${range} → +${b.extraCost}`;
}

/**
 * 作者寫的說明與更新說明，**唯讀**。
 *
 * ⚠ 這兩段原本只有「編輯描述」那一頁看得到，而那是一頁**每一格都能打字**
 * 的編輯畫面 —— 等於要收到規則的人為了讀說明去冒改壞的風險。它們是規則裡
 * 唯一「作者對拿到規則的人說話」的地方（定價的理由、最小單位、哪些卡刻意
 * 不動），所以選規則的這一頁一定要讀得到。
 *
 * ⚠ 換行要自己轉成 `<br>`：作者是在 textarea 裡打的，分行是他排版的一部分。
 * 一律先 `esc()` 再換 —— 反過來的話那些 `<br>` 會被跳脫掉，而真正的標籤
 * 會活下來。
 */
function ruleProse(rule) {
  const block = (label, text, hint) =>
    text === ""
      ? ""
      : `<div class="row" style="margin-top:8px"><span class="dim">${label}</span></div>
         <div class="hint" style="margin-top:0">${esc(text).replace(/\n/g, "<br />")}</div>` +
        (hint ?? "");
  const desc = block(
    "說明",
    rule.description ?? "",
    // 作者宣告最小單位的地方就是這裡（編輯器只做檢查，不寫進規則檔）。
    "",
  );
  const log = block("更新說明", rule.changelog ?? "", "");
  if (desc === "" && log === "") {
    return `<div class="hint">這份規則<b>沒有寫說明</b>。自己編的話，到「編輯描述」補上 ——
      定價的理由、最小單位、哪些卡刻意不動，收到規則的人只有那裡讀得到。</div>`;
  }
  return desc + log;
}

PAGES["rule/cost"] = () => {
  const st = snap?.status;
  const rule = snap?.costRule ?? null;
  const failure = snap?.costRuleError ?? null;
  const cost = st?.cost ?? {
    phase: "off",
    applied: null,
    unknownKeys: 0,
    penalty: "off",
    penaltyEverywhere: false,
    bands: null,
    enabled: true,
    error: null,
  };

  const chosen = rule
    ? `<div class="card">
         <div class="row"><span class="dim">規則</span><span><b>${esc(rule.name)}</b> ${esc(rule.version)}</span></div>
         <div class="row"><span class="dim">作者</span><span>${esc(rule.publisher)}</span></div>
         ${
           // 四張表分開列。一個總數看不出「這份規則管不管裝備」，而那是
           // 拿到別人的規則檔時第一個要知道的事。0 筆＝那種卡用原版價格。
           [
             ["角色", rule.tableEntries.characters],
             ["怪物卡", rule.tableEntries.monsters],
             ["裝備", rule.tableEntries.equipment],
             ["事件卡", rule.tableEntries.eventCards],
           ]
             .map(
               ([label, n]) =>
                 `<div class="row"><span class="dim">${label}</span><span>${
                   n === 0 ? '<span class="dim">沒定價，用原版</span>' : `${n} 筆`
                 }</span></div>`,
             )
             .join("")
         }
         <div class="row"><span class="dim">遊戲版本</span><span>${esc(rule.gameVersion)}</span></div>
         <div class="row"><span class="dim">核對碼</span><span>${
           rule.shortHash
             ? `<code>${esc(rule.shortHash)}</code>`
             : '<span class="dim">裸規則，沒有核對碼</span>'
         }</span></div>
         <div class="row"><span class="dim">檔案</span><span>${esc(rule.fileName)}</span></div>
         ${
           rule.shortHash
             ? `<div class="hint">跟對手約戰時核對這 8 碼 —— 一樣才代表兩邊算的是同一份規則。
                  這個碼是<b>照檔案內容算出來的</b>，改一個數字它就會變。</div>`
             : `<div class="hint warn">⚠ 這是裸規則檔，沒有內容雜湊，不能拿去跟對手核對。要分享請先跑 <code>companion pack</code>。</div>`
         }
         ${
           rule.rehashedFrom
             ? // 直接改包是支援的做法，所以這不是錯誤 —— 但一定要說，
               // 否則玩家會拿著新數字去跟對手核對舊的碼。
               `<div class="hint warn">⚠ 這個檔案被直接編輯過，核對碼已重算：
                  <code>${esc(rule.rehashedFrom)}</code> → <code>${esc(rule.shortHash ?? "")}</code><br />
                  對手手上那份還是舊的 —— <b>把這個檔案傳給他</b>，兩邊的碼才會一樣。</div>`
             : ""
         }
         ${ruleProse(rule)}
       </div>`
    : failure
      ? // ⚠ 這張卡片是「選了沒反應」的解藥。載入失敗時 costRule 是 null，
        // 沒有它的話這一頁只會說「還沒選規則」—— 跟根本沒按過一模一樣。
        `<div class="card">
         <div class="row"><span class="dim">規則</span><span class="bad"><b>載入失敗，沒有套用</b></span></div>
         <div class="row"><span class="dim">檔案</span><span>${esc(failure.fileName)}</span></div>
         <div class="hint warn">⚠ ${esc(failure.message)}</div>
         ${
           failure.hint
             ? `<div class="hint">${esc(failure.hint).replace(/\n/g, "<br />")}</div>`
             : ""
         }
         <div class="hint">遊戲顯示的仍然是原版 COST。修好之後再選一次。</div>
       </div>`
      : `<div class="card">
         <div class="hint">還沒選規則。遊戲顯示的是原版 COST。</div>
       </div>`;

  const state = `<div class="card">
       ${
         // 「對戰地點」頁那格關著：規則載著給配對用，遊戲畫面不套。下面兩行
         // 會寫「未啟用」—— 不講原因的話看起來像規則沒載成功。
         rule && snap?.profile?.customCostInGame !== true
           ? `<div class="hint">遊戲裡<b>沒有套用</b>這份規則：迪特赫姆與牌組編輯都是官方價，規則只拿來自動配對。要套用到「自訂COST › 對戰地點」打開。</div>`
           : ""
       }
       ${
         // 牌組畫面標題列那顆開關切到「官方」了。規則還載著，只是畫面上
         // 暫時是原版的價格與罰則 —— 要講出來，否則下面兩行看起來像壞掉。
         rule && cost.enabled === false
           ? `<div class="hint warn">⇄ 牌組畫面的開關切在<b>官方</b>：現在顯示的是原版價格與罰則。把 DeckEdit 標題列那顆開關往右撥就回到這份規則。</div>`
           : ""
       }
       <div class="row"><span class="dim">卡片價格</span><span>${
         COST_PHASE_TEXT[cost.phase] ?? cost.phase
       }</span></div>
       <div class="row"><span class="dim">壓 C 罰則</span><span>${
         cost.penalty === "applied"
           ? cost.penaltyEverywhere
             ? "生效中（立即，全遊戲）"
             : "生效中（⚠ 目前只有牌組畫面）"
           : (COST_PENALTY_TEXT[cost.penalty] ?? cost.penalty)
       }</span></div>
       ${
         cost.applied !== null
           ? `<div class="row"><span class="dim">已改寫</span><span>${cost.applied} 張卡</span></div>`
           : ""
       }
       ${
         cost.unknownKeys > 0
           ? `<div class="hint warn">⚠ 規則有 ${cost.unknownKeys} 個鍵這個客戶端沒有。規則可能是給別的遊戲版本用的 —— 那些卡會被當成 99C。</div>`
           : ""
       }
       ${cost.error ? `<div class="hint warn">⚠ ${esc(cost.error)}</div>` : ""}
       ${
         cost.phase === "pending"
           ? `<div class="hint">遊戲還沒載入卡片資料（或還沒接上遊戲）—— 載進來的那一刻就會套上，不必重載。</div>`
           : ""
       }
     </div>`;

  const bands = rule
    ? rule.bands === null
      ? `<div class="card"><div class="hint">這份規則不壓 C。</div></div>`
      : `<div class="card">
           <div class="row"><span class="dim">壓 C</span><span>${rule.bands.length} 段</span></div>
           ${rule.bands
             .map(
               (b) =>
                 `<div class="row"><span class="dim">·</span><span>${esc(bandText(b))}</span></div>`,
             )
             .join("")}
           <div class="hint">壓 C 是<b>隊內每一對出戰卡</b>各判一次，三張就是三對。
             <b>怪物卡也算</b> —— 它跟角色共用同樣那三個槽位；
             裝備與事件卡計入總和但<b>不</b>參與壓 C。<br />
             遊戲畫面上的 <code>+N</code> 徽章與總和都會照這張表重算。<br />
             ⚠ 對戰大廳的 <code>cost:</code> 是<b>進場時跟伺服器要的</b>，
             換規則後要離開再進去一次才會重新抓。<br />
             ⚠ 存牌組時送上伺服器的仍然是<b>原版數字</b> —— 插件不改變伺服器的判定。</div>
         </div>`
    : "";

  // ⚠ **這張卡要放在最上面。** 它是這一頁唯一「按了會發生事情」的地方，
  // 而下面那幾張（規則明細、狀態、壓 C 分段）加起來比視窗高得多 ——
  // 擺在最後的話每次想換規則都要先捲一大段。說明性的內容排在動作後面。
  // 規則從哪裡來。⚠ 這三個是**互斥的模式**，不是三顆各自做一件事的按鈕 ——
  // 畫面一定要看得出「現在是哪一個」，否則玩家按了「用預設」之後，
  // 那顆按鈕跟沒按過長得一模一樣。
  const mode = snap?.costRuleMode ?? "default";
  const origin = snap?.costRuleOrigin ?? null;
  // ⚠ 選中的那顆用 `aria-pressed`（CSS 已經有那條規則）而不是自訂 class ——
  // 這一頁的其他分段選擇器都是這樣，換一種寫法會讓它看起來不像同一組東西。
  const modeButton = (id, value, label) =>
    `<button id="${id}" aria-pressed="${mode === value}"${mode === value ? " disabled" : ""}>${label}</button>`;

  const actions = `<div class="card">
       <div class="presets">
         ${modeButton("costModeDefault", "default", "插件附的規則")}
         ${modeButton("costModeFile", "file", "自己的規則檔")}
         ${modeButton("costModeOff", "off", "不套用（原版數字）")}
       </div>
       <div class="presets">
         ${mode === "file" ? `<button id="costPick">選規則檔…</button>` : ""}
       </div>
       ${
         mode === "default"
           ? `<div class="hint">插件附了一份預設規則，<b>裝上就會套用</b>，之後也會自己更新
                （每小時檢查一次，簽章驗過才收）。${
                  origin === "feed"
                    ? "目前用的是<b>更新下來</b>的那一份。"
                    : origin === "bundled"
                      ? "目前用的是<b>安裝包裡</b>那一份。"
                      : ""
                }</div>`
           : mode === "file"
             ? `<div class="hint">用你自己選的那個檔。⚠ 這個模式下<b>插件不會替你更新規則</b> ——
                  檔案是你的，我們一個位元組都不碰。</div>`
             : `<div class="hint">遊戲顯示原版 COST。⚠ 大廳那顆<b>快速比賽</b>在這個模式下用不了（沒有規則就沒有「約定」可言）。</div>`
       }
       <div class="hint">換規則<b>當場生效</b>，不會重載遊戲。</div>
     </div>`;

  return (
    head(
      "Cost 表",
      "套用自訂 COST —— 角色、怪物、裝備、事件卡四張表。只改本機顯示，不會改變伺服器的判定。",
    ) +
    actions +
    chosen +
    state +
    bands +
    `<div class="card">
       <div class="hint">
         規則檔怎麼來：<code>companion official-rule</code> 匯出一份原版表
         （四張表一次全帶），<b>直接改裡面的數字</b>就是你的版本了 ——
         核對碼會在載入時自動重算，不用先解包。改完把檔案傳給對手，
         兩邊的碼一樣就是同一份規則。<br />
         四張表的鍵：角色 <code>cc078_04</code>、怪物 <code>mc001_01</code>、
         裝備 <code>wp001</code>、事件卡 <code>ev091</code>。
         後兩者的數字是<b>補零到三位的卡片編號</b>，寫成 <code>wp1</code> 不算數。
       </div>
     </div>`
  );
};

// --- 自訂COST › 編輯 COST ----------------------------------------------
//
// 這一頁存在的理由只有一句：**規則檔裡是 `cc001_01`，玩家看得懂的是
// 「艾伯李斯特 L1」。** 中間那份對照叫名冊（catalog），從玩家自己跑著的
// 客戶端讀出來，存在家目錄重複使用。
//
// ⚠ 這一頁的資料**不在 snapshot 裡**：四張表加起來 1186 筆，而快照每次
// 狀態變動都整份重送。開頁時用 `editor.load()` 拉一次就好。

/** 編輯器的全部狀態。`null` = 還沒載入。 */
let ed = null;
/** 四張表哪一張開著。 */
let edTab = "characters";
/** 名字的篩選字串。700 位角色，沒有它找不到人。 */
let edFilter = "";
/** 上一次存檔的結果，畫在按鈕旁邊。 */
let edMsg = null;
/** 正在載入中，避免重複發 IPC。 */
let edLoading = false;
/**
 * 按一下上下鍵動多少。
 *
 * ⚠ **真實來源是設定檔**（`profile.editStep`），這裡只是畫面上那一份 ——
 * 跟開房設定同一套：改了要立刻送出去（`window.ulr.editor.step`），
 * 否則下一次重載 payload 就把它打回去了。
 *
 * 先給 1 是為了「payload 還沒回來時也畫得出格子」。
 */
let edStep = 1;
/**
 * 最小單位檢查的值。**0 = 不檢查**，預設。
 *
 * ⚠ 真實來源同樣是設定檔（`profile.editUnit`），而且它**跟著玩家走、不
 * 跟著規則走** —— 規則檔裡沒有這個欄位（見主程序 `normalizeEditUnit` 的
 * 說明）。換一份規則來編要自己重設。
 */
let edUnit = 0;
/** 只看不合單位的格子。⚠ 跟名字篩選是 AND，兩個可以一起用。 */
let edOnlyOff = false;
/**
 * 把官方還沒出的卡藏起來。**預設藏。**
 *
 * ⚠ 這一個**刻意不記進設定檔**，跟 `edStep`／`edUnit` 不一樣。那兩個是
 * 作者在調的「值」（每個人不同，重設一次很煩）；這個是純粹的檢視開關，
 * 而它的預設值對每個人都是對的 —— 開著插件的期間改了就一直是那樣，
 * 重開回到「藏」，那正是想要的。少一個設定欄位、少一條 IPC、少一次遷移。
 */
let edHideLocked = true;

const onEditPage = () => tab === "rule" && sub === "costedit";

const ED_TABS = [
  { id: "characters", label: "角色卡" },
  { id: "eventCards", label: "事件卡" },
  { id: "equipment", label: "裝備卡" },
  { id: "monsters", label: "怪物卡" },
];

/**
 * 換上下鍵的幅度，**並記進設定檔**。
 *
 * ⚠ 主程序夾過的那個值才是真的（0、負數、三位小數都會被夾），所以畫面
 * 用回傳值而不是用玩家打的那個 —— 否則「打了 0」會讓畫面寫著 0、實際上
 * 是 1，而那一格看起來就是壞的。
 *
 * ⚠ 只重畫這一頁。700 個格子的 `step` 全都要換，躲不掉整頁重畫 ——
 * 但玩家是按按鈕／改完那一格才會走到這裡，游標不在價格格子裡。
 */
/**
 * 換「等候套用」的秒數，**並記進設定檔**。
 *
 * ⚠ 拿主程序夾過的那個值回填（跟 `applyEditStep` 同一招）—— 玩家打了
 * 一個超出範圍的數字時，畫面要當場變成真的被存下來的那個值，而不是
 * 留著他打的那個然後安靜地跑另一個。
 */
function applyDeckDelay(value) {
  return window.ulr.deck.applyDelay(Number(value)).then((saved) => {
    if (snap !== null) snap.profile.applyDelaySeconds = saved;
    renderBody();
  });
}

function applyEditStep(value) {
  return window.ulr.editor.step(Number(value)).then((saved) => {
    edStep = saved;
    if (ed !== null) ed.editStep = saved;
    renderBody();
  });
}

/**
 * 換最小單位，**並記進設定檔**。0 = 不檢查。
 *
 * ⚠ 這支跟 `applyEditStep` 一樣**不碰規則檔** —— 檢查是編輯器的功能，
 * 規則檔裡沒有「最小單位」這個欄位。
 */
function applyEditUnit(value) {
  return window.ulr.editor.unit(Number(value)).then((saved) => {
    edUnit = saved;
    if (ed !== null) ed.editUnit = saved;
    // 關掉檢查的話「只看不合的」就沒有意義了，順手關掉 —— 留著的話畫面
    // 會變成一片空白（沒有任何格子不合），而玩家不會把那個空白跟這顆
    // 開關連在一起。
    if (saved === 0) edOnlyOff = false;
    renderBody();
  });
}

/**
 * 十進位 → 整數百分之一。**不做 `v * 100`。**
 *
 * ⚠ `21.35 * 100` 是 2134.9999999999998，而這個值等一下要拿去取餘數 ——
 * 浮點的餘數會讓「剛好合單位」的格子隨機被判成不合。改從十進位字串取
 * 數字，跟引擎的 `toCentiCost`（`@ulr/rule-schema` 的 cost-number.ts）
 * 是同一套算法，兩邊對同一個值一定得到同一個整數。
 *
 * 超過兩位小數回 `null` —— 那種值連規則檔都收不下（`toCentiCost` 會拋），
 * 呼叫端一律當成「不合單位」。
 */
function edCenti(value) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (m === null) return null;
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 100 + frac);
}

/** 這個數字是最小單位的整數倍嗎。`unit` 是 0 時永遠算合格。 */
function edFitsUnit(value, unit) {
  if (!unit) return true;
  const v = edCenti(value);
  const u = edCenti(unit);
  if (v === null || u === null || u === 0) return true;
  return v % u === 0;
}

/**
 * 這個單位疊幾個才會變成整數，以及疊出來是幾 C。
 *
 * ⚠ **「除不盡 1」不等於「湊不出整數」**，這兩件事一定要分開講。任何單位
 * 疊夠多次都會撞上整數 —— `0.33 × 100 = 33C`。作者真正在意的是**湊不湊得出
 * 剛好 1C**（那是「三張卡合起來加 1C」那種設計要的東西），而那要的是
 * 「單位除得盡 1」，比前者嚴格。
 *
 * 幾個才夠：`k = 100 / gcd(單位的百分之一, 100)`。
 */
function edUnitReach(unit) {
  const u = edCenti(unit);
  if (u === null || u <= 0) return null;
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const k = 100 / gcd(u, 100);
  return { count: k, whole: (u * k) / 100, makesOne: u <= 100 && 100 % u === 0 };
}

/**
 * 官方還沒出這張卡（名冊算好的）。查不到就當它出了。
 *
 * ⚠ **方向不能反。** 名冊是舊版快取時 `locked` 根本不存在，那時要當成
 * 「都出了」—— 反過來的話按下「重讀名冊」之前整頁會是空的。
 */
function edLocked(tableId, key) {
  return edLockedKeys()[tableId]?.[key] === true;
}

/**
 * 規則鍵 → locked，四張表各一份。
 *
 * ⚠ 建一次就留著。角色那一頁每畫一格都會問，而名冊有 1186 張卡 ——
 * 每次都線性掃一遍會變成平方級。名冊換掉時（重讀）整份丟掉重建。
 */
let edLockCache = null;
function edLockedKeys() {
  if (edLockCache !== null && edLockCache.cat === ed?.catalog) return edLockCache.map;
  const map = { characters: {}, monsters: {}, equipment: {}, eventCards: {} };
  const cat = ed?.catalog;
  if (cat) {
    for (const g of cat.characters ?? [])
      for (const c of g.cards) if (c.locked) map.characters[c.key] = true;
    for (const g of cat.monsters ?? [])
      for (const c of g.cards) if (c.locked) map.monsters[c.key] = true;
  }
  // 裝備與事件卡沒有升級圖，永遠是空的 —— 留著空物件讓呼叫端不必分case。
  edLockCache = { cat, map };
  return map;
}

/** 這一格現在畫不畫得出來（被藏起來的就摸不到）。 */
function edVisible(tableId, key) {
  return !(edHideLocked && edLocked(tableId, key));
}

/** 這一格不合單位嗎。⚠ 看的是**草稿**，所以邊改邊亮。 */
function edOffUnit(tableId, key) {
  if (!edUnit || ed === null) return false;
  return !edFitsUnit(ed.draft[tableId][key], edUnit);
}

/**
 * 各處有幾格不合單位。⚠ 要分開報 —— 不然玩家不知道要切到哪一頁。
 *
 * ⚠⚠ **壓 C 的 `extraCost` 也要算。** 它跟卡片價格一樣直接加進隊伍總和，
 * 所以一段 +0.3 的罰則會讓一張「每一格都是 0.5 的倍數」的表照樣算出
 * 非 0.5 倍數的總和。漏掉它的話這個檢查會給出**假的全部通過** ——
 * 那比沒有檢查更糟，因為作者會相信它。
 *
 * 壓 C 在另一頁（編輯規則），但 payload 本來就帶著它，所以這裡讀得到。
 *
 * ⚠ **被藏起來的卡另外算（`hidden`）。** 併進 `total` 的話會出現
 * 「說有 3 格不合，按『只看這些』卻一格都沒有」—— 因為那幾格正被藏著。
 * 分開報之後那句話變成可行動的：把「顯示還沒出的卡」打開就看得到。
 */
function edOffCounts() {
  const out = { total: 0, bands: 0, hidden: 0 };
  for (const t of ED_TABS) {
    let n = 0;
    if (ed !== null && edUnit)
      for (const k of Object.keys(ed.draft[t.id])) {
        if (!edOffUnit(t.id, k)) continue;
        if (edVisible(t.id, k)) n++;
        else out.hidden++;
      }
    out[t.id] = n;
    out.total += n;
  }
  if (ed !== null && edUnit) {
    for (const b of ed.compression?.bands ?? []) if (!edFitsUnit(b.extraCost, edUnit)) out.bands++;
  }
  out.total += out.bands;
  return out;
}

/** 名冊裡有幾張是官方還沒出的。0 = 這份名冊判斷不了（或全出了）。 */
function edLockedCount() {
  const map = edLockedKeys();
  return Object.keys(map.characters).length + Object.keys(map.monsters).length;
}

function edLoad(force) {
  if (edLoading) return;
  if (ed !== null && !force) return;
  edLoading = true;
  window.ulr.editor.load().then((payload) => {
    edLoading = false;
    ed = decorate(payload);
    if (onEditPage()) renderBody();
  });
}

/**
 * 把 IPC 送來的東西整理成畫面直接可用的樣子。
 *
 * 兩件事：
 * 1. **原價索引**（`base`）—— 每一格都要知道「原本是多少」，才畫得出
 *    「改過了」與「改回原價」。
 * 2. **草稿**（`draft`）—— 規則裡沒有的鍵先用原價填。那正是「舊規則只有
 *    角色表」的升級路徑：打開編輯器、按存檔，四張表就補齊了。
 */
function decorate(payload) {
  const base = {};
  const draft = {};
  for (const t of ED_TABS) {
    base[t.id] = {};
    draft[t.id] = {};
  }
  const cat = payload.catalog;
  if (cat) {
    for (const g of cat.characters) for (const c of g.cards) base.characters[c.key] = c.baseCost;
    for (const g of cat.monsters) for (const c of g.cards) base.monsters[c.key] = c.baseCost;
    for (const g of cat.equipment) for (const i of g.items) base.equipment[i.key] = i.baseCost;
    for (const g of cat.eventCards) for (const i of g.items) base.eventCards[i.key] = i.baseCost;
  }
  for (const t of ED_TABS) {
    const fromRule = payload.tables?.[t.id] ?? {};
    for (const k of Object.keys(base[t.id])) draft[t.id][k] = base[t.id][k];
    // 規則寫了什麼就蓋上去。⚠ 規則有、名冊沒有的鍵也要留著 —— 那是
    // 「規則比客戶端新（或舊）」的訊號，默默丟掉等於偷改別人的規則。
    for (const k of Object.keys(fromRule)) draft[t.id][k] = fromRule[k];
  }
  // 載入當下的樣子。**跟 base 是兩回事**，見 edUnsaved()。
  const saved = JSON.parse(JSON.stringify(draft));
  // 幅度是設定檔裡那份。⚠ 這一行讓「重讀名冊」之後幅度不會被打回預設 ——
  // 那支也回一份完整的 payload。
  if (typeof payload.editStep === "number") edStep = payload.editStep;
  if (typeof payload.editUnit === "number") edUnit = payload.editUnit;
  return { ...payload, base, draft, saved };
}

/**
 * 這一格跟**遊戲原價**差幾 C。`null` = 不知道原價，或一模一樣。
 *
 * 名冊沒有原價時（規則比客戶端新）一律當成沒改：我們不知道原價是多少，
 * 標成「改過了」是在講一件自己也不確定的事。
 *
 * ⚠ 先夾到兩位小數再比。價格是玩家在輸入框打的，而 `13.1 - 13` 在浮點
 * 底下是 0.10000000000000053 —— 不夾的話色階會在邊界上抖。
 */
function edDelta(tableId, key) {
  const b = ed?.base[tableId]?.[key];
  if (b === undefined) return null;
  const d = Math.round((ed.draft[tableId][key] - b) * 100) / 100;
  return d === 0 ? null : d;
}

function edChanged(tableId, key) {
  return edDelta(tableId, key) !== null;
}

/**
 * 這一格要穿哪一身顏色。
 *
 * 五階，**第 5 階是上限** —— 貴 5C 跟貴 50C 同一個顏色。理由是玩家在這
 * 張表上找的是「我把誰調貴了」，不是精確讀數；再往下分階只會讓相鄰的
 * 兩階在 11.5px 的格子裡分不出來。精確的數字就在格子裡，滑過去還有
 * `title` 寫著原價與差值。
 *
 * ⚠ 不滿 1C 也算第一階（`ceil`）。動了就是動了，13 → 13.5 不標的話
 * 那一格看起來跟沒改過一模一樣。
 */
function edDeltaClass(tableId, key) {
  const d = edDelta(tableId, key);
  if (d === null) return "";
  const level = Math.min(5, Math.ceil(Math.abs(d) - 1e-9));
  return `dirty ${d > 0 ? "up" : "dn"}${level}`;
}

/**
 * 這一格跟**檔案裡存著的值**不一樣嗎 —— 決定存檔鈕與「未存檔」計數。
 *
 * ⚠ **這兩件事一定要分開。** 一份自訂規則本來就有一堆格子跟原價不同
 * （夾擠式那份就有兩格），拿「跟原價不同」當存檔鈕的條件的話，存完檔
 * 按鈕仍然亮著、上面還寫著「改動 4 格」—— 玩家會一直以為自己有東西沒存。
 */
function edUnsaved(tableId, key) {
  return ed.draft[tableId][key] !== ed.saved[tableId][key];
}

function edUnsavedCount() {
  if (ed === null) return 0;
  let n = 0;
  for (const t of ED_TABS) for (const k of Object.keys(ed.draft[t.id])) if (edUnsaved(t.id, k)) n++;
  return n;
}

/** 跟原版不一樣的格數 —— 「這份規則到底動了多少東西」。 */
function edCustomCount() {
  if (ed === null) return 0;
  let n = 0;
  for (const t of ED_TABS) for (const k of Object.keys(ed.draft[t.id])) if (edChanged(t.id, k)) n++;
  return n;
}

/** 篩選：名字對得上就留。空字串代表全部。 */
function edMatch(name) {
  if (edFilter === "") return true;
  return name.toLowerCase().includes(edFilter.toLowerCase());
}

/**
 * 一個數字格。
 *
 * `data-k` 帶的是規則鍵（`cc001_01`）—— 程式要靠它定位，但**它不顯示**。
 * `title` 也帶著，是為了玩家回報問題時說得出是哪一張。
 */
/**
 * 一整格（含外層 `ecell`）。**藏起來的卡留一個空格子，不是拿掉。**
 *
 * ⚠ 版面是固定十欄的格線（`egrid c10`），而每位角色缺的等級不一樣
 * （有人缺 R2~R5、有人只缺 R5）。真的把 `<div>` 拿掉的話，每一列會各自
 * 往左縮，`L1…R5` 的欄頭就對不上任何一列了 —— 那比不藏更難看。
 */
function edCell(tableId, key, label) {
  if (!edVisible(tableId, key)) {
    return `<div class="ecell"><div class="nocard" title="${esc(label)}（${esc(key)}）&#10;官方還沒開放這張卡"></div></div>`;
  }
  return `<div class="ecell">${edInput(tableId, key, label)}</div>`;
}

function edInput(tableId, key, label) {
  const v = ed.draft[tableId][key];
  // ⚠ `step` 在瀏覽器眼裡不只是「上下鍵動多少」，它同時是一張**格線**：
  // step=1 時 13.5 會被判成 stepMismatch（`:invalid`）。這裡是刻意接受的
  // ——「解析度」要的正是那條格線（上下鍵會對齊到整數），而我們沒有替
  // `:invalid` 上任何樣式，玩家自己打的小數照樣收得下來（真正的驗證在
  // 主程序的 `sanitizeTable`，不是在瀏覽器）。
  // ⚠ 不合單位的框線加在 `class` 上而不是換掉價差色階 —— 兩件事要能
  // **同時**看得到：一格可以既「比原版貴 3C」又「不是 0.5 的倍數」，
  // 而作者兩個資訊都需要。色階吃背景色，這個吃外框。
  const off = edOffUnit(tableId, key) ? " offunit" : "";
  // 選擇「顯示還沒出的卡」時，它們仍然要看得出來 —— 淡化而不是拿掉。
  const lock = edLocked(tableId, key) ? " lockedcard" : "";
  return (
    `<input type="number" step="${edStep}" class="${edDeltaClass(tableId, key)}${off}${lock}" value="${v}" ` +
    `data-t="${tableId}" data-k="${esc(key)}" title="${esc(edTitle(tableId, key, label))}" />`
  );
}

/**
 * 這一組（一位角色、一個武器族群…）要不要畫出來。
 *
 * 名字篩選與「只看不合單位的」是 **AND** —— 兩個一起用才找得到
 * 「艾伯那一排裡不合單位的那幾格」。
 */
function edKeepGroup(tableId, matched, keys) {
  if (!matched) return false;
  if (!edOnlyOff) return true;
  // ⚠ 只算**畫得出來**的那些。被藏起來的卡就算不合單位也碰不到，把整列
  // 留下來只會給出一列每一格都空白的東西。
  return keys.some((k) => edVisible(tableId, k) && edOffUnit(tableId, k));
}

/** 篩到一個都不剩時說的話。⚠ 要分得出是哪一個條件篩掉的。 */
function edEmptyText() {
  if (edOnlyOff && edFilter === "") return "這一頁每一格都合最小單位。";
  if (edOnlyOff) return `「${edFilter}」裡沒有不合最小單位的格子。`;
  return `沒有名字對得上「${edFilter}」。`;
}

/** 「原價多少、現在差多少」。色階只分到五階，精確的差值在這裡。 */
function edDeltaText(tableId, key) {
  const base = ed?.base[tableId]?.[key];
  if (base === undefined) return "⚠ 名冊裡沒有這張，不知道原價";
  const d = edDelta(tableId, key);
  if (d === null) return `原價 ${base}，沒改`;
  return `原價 ${base} → ${d > 0 ? `貴 ${d}C` : `便宜 ${-d}C`}`;
}

/**
 * 滑鼠停著時的說明：這是哪一張、原價多少、差多少、合不合單位。
 *
 * ⚠ 不合單位那一行要寫**現在的值**與**單位**。光看一圈洋紅虛線，作者知道
 * 「這格有問題」卻不知道問題是什麼 —— 而 1186 格裡他多半已經忘記自己設的
 * 單位是多少了。
 */
function edTitle(tableId, key, label) {
  const off = edOffUnit(tableId, key)
    ? `\n⚠ ${ed.draft[tableId][key]} 不是最小單位 ${edUnit} 的整數倍`
    : "";
  const lock = edLocked(tableId, key) ? "\n⚠ 官方還沒開放這張卡（沒有配方做得出來）" : "";
  return `${label}（${key}）\n${edDeltaText(tableId, key)}${off}${lock}`;
}

/** 角色：一位一排，L1~L5 R1~R5。欄頭只印一次。 */
function edCharacters(cat) {
  const groups = cat.characters.filter((g) =>
    edKeepGroup(
      "characters",
      edMatch(g.name),
      g.cards.map((c) => c.key),
    ),
  );
  if (groups.length === 0) return `<div class="hint">${esc(edEmptyText())}</div>`;
  const slots = groups[0].cards.map((c) => `<div class="slot">${esc(c.slot)}</div>`).join("");
  const head = `<div class="ehead"><div class="ename">角色</div><div class="egrid c10">${slots}</div></div>`;
  const rows = groups
    .map(
      (g) =>
        `<div class="erow"><div class="ename" title="${esc(g.name)}">${esc(g.name)}</div>` +
        `<div class="egrid c10">${g.cards
          .map((c) => edCell("characters", c.key, `${g.name} ${c.slot}`))
          .join("")}</div></div>`,
    )
    .join("");
  return head + rows;
}

/** 怪物：M1~M3，一排放三種不同的怪物。 */
function edMonsters(cat) {
  const groups = cat.monsters.filter((g) =>
    edKeepGroup(
      "monsters",
      edMatch(g.name),
      g.cards.map((c) => c.key),
    ),
  );
  if (groups.length === 0) return `<div class="hint">${esc(edEmptyText())}</div>`;
  const blocks = groups.map(
    (g) =>
      `<div class="mblock"><div class="mname" title="${esc(g.name)}">${esc(g.name)}</div>` +
      `<div class="egrid c3">${g.cards
        .map((c) => `<div class="slot">${esc(c.slot)}</div>`)
        .join("")}</div>` +
      `<div class="egrid c3">${g.cards
        .map((c) => edCell("monsters", c.key, `${g.name} ${c.slot}`))
        .join("")}</div></div>`,
  );
  const rows = [];
  for (let i = 0; i < blocks.length; i += 3) {
    rows.push(`<div class="mrow">${blocks.slice(i, i + 3).join("")}</div>`);
  }
  return rows.join("");
}

/**
 * 裝備：照「這是誰的專武」分組，一排 5 件。
 *
 * ⚠ 角色限制一定要標出來 —— 一件只有某位角色帶得動的武器，跟通用武器的
 * 定價考量完全不同。實測 238 件裡有 212 件是專武。
 */
function edEquipment(cat) {
  const groups = cat.equipment
    .map((g) => ({
      ...g,
      items: g.items.filter((i) =>
        edKeepGroup("equipment", edMatch(i.name) || edMatch(g.name), [i.key]),
      ),
    }))
    .filter((g) => g.items.length > 0);
  if (groups.length === 0) return `<div class="hint">${esc(edEmptyText())}</div>`;
  return groups
    .map(
      (g) =>
        `<div class="egroup">${esc(g.name)}` +
        `<span class="sub">${g.charaId === null ? "誰都能帶" : "專武"} · ${g.items.length} 件</span></div>` +
        `<div class="egrid c5">${g.items
          .map(
            (i) =>
              `<div class="ecell"><span class="cn" title="${esc(i.name)}">${esc(i.name)}</span>` +
              `${edInput("equipment", i.key, i.name)}</div>`,
          )
          .join("")}</div>`,
    )
    .join("");
}

/**
 * 事件卡的插槽顏色，索引就是名冊裡的 `slotType`（＝遊戲資料的 `type`）。
 *
 * 色票量自遊戲自己的 `event_slot` 貼圖（2026-08-16，八個 frame）。
 * ⚠ 「黑」取的是貼圖的**鏡邊**顏色而不是填色（填色量到 `#0b0a08`）——
 * 純黑貼在這個深色面板上等於沒畫。同一個取捨在上面 `--ink-off` 也做過：
 * 像它，但不要像到看不見。
 */
const EV_SLOT = [
  { c: "#d82a4e", name: "紅", family: "劍" },
  { c: "#61ca3b", name: "綠", family: "槍" },
  { c: "#038ae9", name: "藍", family: "防禦" },
  { c: "#b403e9", name: "紫", family: "移動" },
  { c: "#ddb13c", name: "黃", family: "特殊" },
  { c: "#f3f4f6", name: "白", family: "機會" },
  { c: "#595142", name: "黑", family: "詛咒" },
  { c: "#bdbdbd", name: "灰", family: "萬用" },
];

/** 名冊沒帶顏色（讀不到那一欄）時回 `null`，呼叫端要能接受沒有顏色。 */
function edSlot(item) {
  return EV_SLOT[item.slotType] ?? null;
}

/**
 * 這張卡的效果說明 —— **名字已經說完的就回空字串**。
 *
 * 110 張裡有 90 張的說明是「此卡當作劍4使用」這種把名字再講一次的樣板，
 * 全部印出來只會讓真正需要讀的那 20 張淹沒在裡面。
 *
 * 判斷方式是「說明裡有沒有出現名字本身」，不是比對那句樣板 —— 樣板的寫法
 * 會隨語言與改版變，而「名字有沒有被複述」在哪一版都成立。認錯的代價也
 * 只是多印一行，不會印錯東西。
 *
 * | 卡          | 說明                     | 顯示   |
 * | ----------- | ------------------------ | ------ |
 * | 劍3·盾3卡   | 此卡當作劍3·盾3使用      | 不顯示 |
 * | Hp恢復      | 回復1點Hp                | 顯示   |
 * | 聚焦卡      | 出牌時,移動階段…加算20點 | 顯示   |
 */
function edEventEffect(item) {
  const info = item.info ?? "";
  if (info === "") return "";
  const stem = item.name.replace(/(卡|カード)$/, "");
  return stem !== "" && info.includes(stem) ? "" : info;
}

/** 事件卡篩選：名字、效果、顏色都算數（打「紅」找得到所有紅卡）。 */
function edEventMatch(item) {
  if (edFilter === "") return true;
  const slot = edSlot(item);
  return (
    edMatch(item.name) ||
    edMatch(item.info ?? "") ||
    (slot !== null && (edMatch(slot.name) || edMatch(slot.family)))
  );
}

/** 左邊那條色帶是什麼意思。**規則寫出來** —— 光看顏色猜不到灰色是萬用。 */
function edEventLegend() {
  const swatches = EV_SLOT.map(
    (s) =>
      `<span><b style="background:${s.c}"></b>${esc(s.name)}<span class="dim">·${esc(
        s.family,
      )}</span></span>`,
  ).join("");
  return (
    `<div class="evlegend"><span>插槽色</span>${swatches}</div>` +
    `<div class="hint" style="margin-top:0">一張事件卡只放得進角色卡上<b>同色</b>的事件插槽 ——
       <b>灰是萬用</b>，哪一格都放得進去。⚠ 顏色跟名字上的等級<b>沒有</b>對應關係
       （「劍3·盾3卡」是紅的，「劍5·槍5卡」卻是萬用），所以定價前先看這條色帶：
       紅卡再便宜，紅槽少的角色也帶不動。</div>`
  );
}

/** 事件卡：族群一塊，一排 9 張（劍1~劍9、劍3·槍1~劍5·移動1…）。 */
function edEvents(cat) {
  const groups = cat.eventCards
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => edKeepGroup("eventCards", edEventMatch(i), [i.key])),
    }))
    .filter((g) => g.items.length > 0);
  if (groups.length === 0) return `<div class="hint">${esc(edEmptyText())}</div>`;
  return (
    edEventLegend() +
    groups
      .map(
        (g) =>
          `<div class="egroup">${esc(g.name)}<span class="sub">${g.items.length} 張</span></div>` +
          `<div class="egrid c9">${g.items
            .map((i) => {
              const slot = edSlot(i);
              const fx = edEventEffect(i);
              // 滑過去看得到完整資訊 —— 名字被切掉、或想確認顏色時要用。
              const label =
                i.name +
                (fx === "" ? "" : ` —— ${fx}`) +
                (slot === null ? "" : `　[${slot.name}·${slot.family}]`);
              return (
                `<div class="ecell ev"${slot === null ? "" : ` style="--slot:${slot.c}"`}>` +
                `<span class="cn" title="${esc(label)}">${esc(i.name)}</span>` +
                (fx === "" ? "" : `<span class="fx" title="${esc(fx)}">${esc(fx)}</span>`) +
                `${edInput("eventCards", i.key, label)}</div>`
              );
            })
            .join("")}</div>`,
      )
      .join("")
  );
}

/** 沒有名冊時這一頁做不了事 —— 要講清楚為什麼，以及下一步按哪裡。 */
function edNoCatalog() {
  const why = ed?.catalogError
    ? `<div class="hint warn">⚠ ${esc(ed.catalogError)}</div>`
    : `<div class="hint">這一頁要先有一份<b>卡片名冊</b>才畫得出來 ——
         規則檔裡是 <code>cc001_01</code>，名冊才知道那是「艾伯李斯特 L1」。
         名冊從<b>你自己跑著的遊戲</b>讀，讀一次就會存起來，之後沒開遊戲也用得了。</div>`;
  return `<div class="card">
       <div class="row"><span class="dim">卡片名冊</span><span class="bad"><b>還沒有</b></span></div>
       ${why}
       <div class="presets" style="margin-top:8px">
         <button id="edCatalog" ${ed?.connected ? "" : "disabled"}>從遊戲讀取名冊</button>
       </div>
       <div class="hint">${
         ed?.connected
           ? "遊戲已接上，按下去就會讀。"
           : "現在還沒接上遊戲 —— 先把遊戲開起來（見「設置 › 連線」）。"
       }</div>
     </div>`;
}

PAGES["rule/costedit"] = () => {
  const title = head(
    "編輯 COST",
    "改自己的規則檔。<b>看到的是卡片名稱，不是編號</b> —— 中間那份對照從你自己的遊戲讀。",
  );
  if (ed === null) {
    edLoad(false);
    return title + `<div class="card"><div class="hint">載入中…</div></div>`;
  }
  if (ed.rule === null) {
    return (
      title +
      `<div class="card">
         <div class="row"><span class="dim">規則</span><span class="bad"><b>還沒選</b></span></div>
         <div class="hint">編輯 COST 是<b>改一份既有的規則檔</b>，所以要先有檔案。
           到「自訂COST › Cost 表」選一份 —— 沒有自己的規則就先選
           <code>unlight-official</code>，那是原版數字的完整四張表，改它就是你的版本了。</div>
       </div>`
    );
  }

  const cat = ed.catalog;
  const unsaved = edUnsavedCount();
  const custom = edCustomCount();
  const size = cat
    ? {
        characters: cat.characters.reduce((n, g) => n + g.cards.length, 0),
        monsters: cat.monsters.reduce((n, g) => n + g.cards.length, 0),
        equipment: cat.equipment.reduce((n, g) => n + g.items.length, 0),
        eventCards: cat.eventCards.reduce((n, g) => n + g.items.length, 0),
      }
    : null;

  const header = `<div class="card">
       <div class="row"><span class="dim">正在編輯</span>
         <span><b>${esc(ed.rule.name)}</b>
           <input type="text" id="edVersion" value="${esc(ed.rule.version)}" style="width:5.5em;margin-left:6px" />
         </span></div>
       <div class="row"><span class="dim">檔案</span><span>${esc(ed.rule.fileName)}</span></div>
       <div class="row"><span class="dim">未存檔</span><span>${
         unsaved === 0
           ? '<span class="dim">沒有，都存好了</span>'
           : `<b class="warn">${unsaved} 格</b>`
       }</span></div>
       <div class="row"><span class="dim">跟原版不同</span><span>${
         custom === 0 ? '<span class="dim">完全照原版</span>' : `${custom} 格`
       }</span></div>
       <div class="presets" style="margin-top:8px">
         <button id="edSave" ${unsaved === 0 ? "disabled" : ""}>存回這個檔</button>
         <button id="edResetTab" class="danger">這一頁全部改回原價</button>
       </div>
       ${edMsg ? `<div class="hint ${edMsg.bad ? "warn" : "good"}">${esc(edMsg.text)}</div>` : ""}
       <div class="hint">存檔會<b>就地覆寫同一個檔</b>，不會多生一份 ——
         核對碼每次都重算。<b>要傳給對手之前記得把版本號改掉</b>（上面那格），
         不然對手會拿舊版本號配到不同內容的規則。</div>
     </div>`;

  if (cat === null) return title + header + edNoCatalog();

  const tabs =
    `<div class="etabs">` +
    ED_TABS.map(
      (t) =>
        `<button data-edtab="${t.id}" aria-selected="${t.id === edTab}">${esc(t.label)}` +
        `<span class="n">${size[t.id]}</span></button>`,
    ).join("") +
    `</div>`;

  const tools = `<div class="row" style="margin-bottom:8px">
       <input type="text" id="edFilter" placeholder="${
         edTab === "eventCards"
           ? "打名字、效果或顏色找卡（例：聖水、回復、紅）"
           : "打名字找卡（例：艾伯、聖水、短劍）"
       }" value="${esc(edFilter)}" style="flex:1" />
       <span class="dim" style="font-size:13px">名冊 ${esc(cat.gameVersion)} · ${esc(
         cat.readAt.slice(0, 10),
       )} 讀的</span>
       <button id="edCatalog" ${ed.connected ? "" : "disabled"}>重讀名冊</button>
     </div>`;

  // 價差色階的圖例。⚠ 沒有這一條的話那些顏色只是「有顏色」—— 玩家看得出
  // 兩格不一樣，卻不知道哪一邊是變貴的。放在表格正上方，跟著捲不走。
  const swatch = (cls) => `<b class="lv ${cls}"></b>`;
  const legend = `<div class="evlegend">
       <span>跟原版差</span>
       <span>${["dn5", "dn4", "dn3", "dn2", "dn1"].map(swatch).join("")}&nbsp;便宜 5C 起 ← 1C</span>
       <span>1C → 貴 5C 起&nbsp;${["up1", "up2", "up3", "up4", "up5"].map(swatch).join("")}</span>
     </div>
     <div class="hint" style="margin-top:0">冷色是<b>調便宜</b>、暖色是<b>調貴</b>，
       越深差越多。<b>第五階是上限</b> —— 差 5C 跟差 50C 同一個顏色，
       精確的數字滑過那一格就看得到。沒上色＝跟原版一模一樣。</div>`;

  // 上下鍵的幅度。⚠ 快速鍵的清單**從主程序來**（`editSteps`），畫面不自己
  // 寫死一份 —— 兩份清單遲早會走散。
  const stepKeys = ed.editSteps ?? [1, 0.5, 0.1, 0.05, 0.01];
  const stepButtons = stepKeys
    .map(
      (n) =>
        `<button class="tier" data-step="${n}"${edStep === n ? ' aria-selected="true"' : ""}>${n}</button>`,
    )
    .join("");
  const steps = `<div class="row" style="margin:2px 0 8px">
       <span class="dim">上下鍵每次 ±</span>
       <span>${stepButtons}
         <input id="edStep" type="number" min="0.01" max="100" step="0.01"
                style="width:5em;margin-left:6px" value="${edStep}" />
       </span>
     </div>
     <div class="hint" style="margin-top:0">按鍵盤上下鍵、或滑鼠在格子上滾輪時一次動多少。
       預設 <b>1</b>：COST 幾乎都是整數，0.01 的意思是「13 調到 14 要按一百次」。
       要更細的自己打一個數字（壓 C 邊界那種 x.99 就會用到）。<b>記在設定裡</b>。</div>`;

  // ── 官方還沒出的卡 ───────────────────────────────────────────────
  //
  // ⚠ **只藏顯示，草稿與存檔照樣含那些鍵。** 從資料裡拿掉的話，官方哪天
  // 開放了（凱倫貝克 R5 就是 2026-08-17 開的），那份規則會安靜地把它算成
  // 99C（`UNKNOWN_COST`），而玩家帶著一張合法的卡會被自己的規則判超標。
  const lockedN = edLockedCount();
  const locks =
    lockedN === 0
      ? ""
      : `<div class="row" style="margin:2px 0 8px">
           <span class="dim">官方還沒出的卡</span>
           <span>${lockedN} 張
             <button id="edHideLocked" class="tier"${edHideLocked ? ' aria-selected="true"' : ""}>${
               edHideLocked ? "已藏起來" : "顯示中"
             }</button>
           </span></div>
         <div class="hint" style="margin-top:0">資產裡有完整資料（數值、技能、插槽都是好的），但
           <b>沒有任何配方做得出來</b> —— 沒有人帶得上場，所以定價也沒有意義。
           判準是遊戲自己的升級圖，<b>官方一開放就會自己跟上</b>（不必更新插件，按一次「重讀名冊」即可）。<br />
           ⚠ 藏起來的只是<b>畫面</b>：它們照樣留在草稿裡、存檔照樣寫進規則檔。
           從規則裡拿掉的話，官方開放的那天你的規則會把它算成 <b>99C</b>。</div>`;

  // 最小單位檢查。⚠ 這是**檢查**，不是限制 —— 它不擋存檔、也不會去改你的
  // 數字，只把不合的格子找出來。1186 格裡混進一個 18.5 用眼睛是找不到的。
  const off = edOffCounts();
  const unitKeys = ed.editUnits ?? [1, 0.5, 0.25, 0.2, 0.1];
  const unitButtons = unitKeys
    .map(
      (n) =>
        `<button class="tier" data-unit="${n}"${edUnit === n ? ' aria-selected="true"' : ""}>${n}</button>`,
    )
    .join("");
  const breakdown = ED_TABS.filter((t) => off[t.id] > 0)
    .map((t) => `${esc(t.label)} ${off[t.id]}`)
    // 壓 C 在另一頁，所以要標出來 —— 不然「只看這些」按下去會什麼都沒有，
    // 而計數還寫著有幾格不合。
    .concat(off.bands > 0 ? [`壓 C ${off.bands} 段（在「編輯規則」那一頁）`] : [])
    .join("、");
  const unit = `<div class="row" style="margin:2px 0 8px">
       <span class="dim">最小單位</span>
       <span><button class="tier" data-unit="0"${edUnit === 0 ? ' aria-selected="true"' : ""}>不檢查</button>
         ${unitButtons}
         <input id="edUnit" type="number" min="0" max="100" step="0.01"
                style="width:5em;margin-left:6px" value="${edUnit}" />
       </span></div>
     ${
       edUnit === 0
         ? `<div class="hint" style="margin-top:0">選一個單位，插件就會把<b>不是它整數倍</b>的格子框起來 ——
              1186 格裡混進一個 18.5，用眼睛是找不到的。<b>不擋存檔、也不會動你的數字</b>，只是找出來。</div>`
         : `<div class="row"><span class="dim">不合單位</span><span>${
             off.total === 0
               ? // ⚠ 這句涵蓋四張表**加上壓 C**。只查表的話它是假的全部通過。
                 '<span class="good">沒有，四張表與壓 C 都是 ' +
                 esc(String(edUnit)) +
                 " 的倍數</span>"
               : `<b class="warn">${off.total} 格</b>${
                   breakdown === "" ? "" : `<span class="dim">（${breakdown}）</span>`
                 }
                  <button id="edOnlyOff" class="tier"${
                    edOnlyOff ? ' aria-selected="true"' : ""
                  }>${edOnlyOff ? "看全部" : "只看這些"}</button>`
           }${
             // ⚠ 藏起來的那些**分開報**。併進上面那個數字的話，會出現
             // 「說有 3 格不合，按『只看這些』卻一格都沒有」。
             off.hidden > 0
               ? `<div class="hint" style="margin:4px 0 0">另有 <b>${off.hidden} 格</b>在<b>官方還沒出的卡</b>上（正被藏著，改不到）。
                    要處理的話先把上面那顆切成「顯示中」。</div>`
               : ""
           }</span></div>
            <div class="hint" style="margin-top:0">${
              // ⚠ 湊不出剛好 1C 的單位要**當場講**。作者設 0.33 多半是想要
              // 「三張湊 1C」，而 0.33×3 = 0.99 —— 那個 0.01 的缺口不講的話，
              // 他會在整張表定完價、甚至傳給對手之後才發現。
              (() => {
                const r = edUnitReach(edUnit);
                if (r === null) return "";
                const head = `${r.count} 個 ${esc(String(edUnit))} 湊得出剛好 ${r.whole}C。`;
                return r.makesOne
                  ? head
                  : `${head} ⚠ 但<b>湊不出剛好 1C</b> —— 引擎的最小刻度是 0.01，
                       而 ${esc(String(edUnit))} 除不盡 1。想要「三張合起來剛好 1C」的話，
                       三分之一在兩位小數裡表達不出來，最接近的做法是把那三張定成
                       <code>0.33 / 0.33 / 0.34</code>。`;
              })()
            }
              這個值<b>記在設定裡，但不會寫進規則檔</b> —— 規則檔沒有「最小單位」這個欄位。
              要讓拿到規則的人知道，請自己寫進「<b>編輯描述</b>」的說明欄（那一段在「Cost 表」那一頁讀得到）。</div>`
     }`;

  const body =
    edTab === "characters"
      ? edCharacters(cat)
      : edTab === "monsters"
        ? edMonsters(cat)
        : edTab === "equipment"
          ? edEquipment(cat)
          : edEvents(cat);

  return (
    title +
    header +
    tabs +
    tools +
    `<div class="card">${legend}${steps}${locks}${unit}${body}</div>`
  );
};

// --- 自訂COST › 編輯規則 -----------------------------------------------
//
// 「編輯 COST」改的是**價格**（1186 個數字格），這一頁改的是**規則本身**。
// 目前規則裡除了價格以外唯一有行為意義的欄位就是壓 C（`compressionRule`），
// 所以這一頁現在只有壓 C。原版那份與自訂那份都改得動 —— 它們是同一種檔案，
// 差別只在裡面的數字。
//
// ⚠ 隊伍 COST 上限**刻意不在這裡**。它是<b>對戰環境</b>的屬性而不是規則的
// 屬性（伺服器按頻道下發，客戶端裡根本沒有這個常數），約定值填在「配對」
// 那一頁 —— 見 docs/official-cost-rule.md 的「上限不在規則裡」。

/** 這一頁的全部狀態。`null` = 還沒載入。 */
let rl = null;
let rlMsg = null;
let rlLoading = false;

const onRulePage = () => tab === "rule" && sub === "ruleedit";

/** 官方的兩段。「改回原版壓 C」那顆按的就是它。 */
const RL_OFFICIAL = [
  { minGap: 7, maxGap: 13, extraCost: 5 },
  { minGap: 14, maxGap: null, extraCost: 10 },
];

function rlLoad(force) {
  if (rlLoading) return;
  if (rl !== null && !force) return;
  rlLoading = true;
  window.ulr.editor.load().then((payload) => {
    rlLoading = false;
    const bands = (payload.compression?.bands ?? []).map((b) => ({
      minGap: b.minGap,
      // ⚠ 主程序那邊「沒有上界」是**欄位不存在**，這裡一律正規化成 null。
      // 留著 undefined 的話 `b.maxGap === null` 那些判斷會全部漏掉它。
      maxGap: b.maxGap === undefined || b.maxGap === null ? null : b.maxGap,
      extraCost: b.extraCost,
    }));
    rl = { rule: payload.rule, bands, saved: JSON.stringify(bands) };
    if (onRulePage()) renderBody();
  });
}

/** 跟檔案裡存著的不一樣嗎 —— 決定存檔鈕。 */
function rlDirty() {
  return rl !== null && JSON.stringify(rl.bands) !== rl.saved;
}

/**
 * 存不下去的錯。**跟主程序那邊是同一套判準**（`validateCostRule` 的
 * `band.*`），先在畫面上擋是為了讓玩家看到是哪一段，而不是存檔時收到
 * 一句 JSON Pointer。
 */
function rlIssues(bands) {
  const bad = [];
  bands.forEach((b, i) => {
    if (!Number.isFinite(b.minGap) || !Number.isFinite(b.extraCost)) {
      bad.push(`第 ${i + 1} 段有欄位空著或不是數字。`);
    }
    if (b.maxGap !== null && b.maxGap < b.minGap) {
      bad.push(`第 ${i + 1} 段的上界 ${b.maxGap} 比下界 ${b.minGap} 小。`);
    }
  });
  if (bands.filter((b) => b.maxGap === null).length > 1) {
    bad.push("只能有一段留空上界（＝無上界），否則兩段一定重疊。");
  }
  const sorted = bands.map((b, i) => ({ ...b, i })).sort((a, b) => a.minGap - b.minGap);
  for (let n = 1; n < sorted.length; n++) {
    const prev = sorted[n - 1];
    const cur = sorted[n];
    const end = prev.maxGap === null ? Infinity : prev.maxGap;
    if (cur.minGap <= end) {
      bad.push(`第 ${prev.i + 1} 段與第 ${cur.i + 1} 段重疊 —— 同一個差距會對應到兩個追加值。`);
    }
  }
  return bad;
}

/**
 * 兩段之間的縫隙。**這是警告不是錯誤**，但它是這個表最容易踩的坑。
 *
 * 點狀區間（`[7,7]`、`[8,8]`…）碰到**小數差距**會整段落空：角色 COST 一旦
 * 有小數，差距就是小數，而 7.5 在 [7,7] 與 [8,8] 之間一段都不中 →
 * 完全不罰，而且完全沒有提示。2026-08-15 的 `shinon/squeeze-band` 就是
 * 這樣整條曲線消失的，所以規則檔的上界才寫成 x.99。
 */
function rlHoles(bands) {
  const sorted = bands
    .filter((b) => Number.isFinite(b.minGap))
    .map((b, i) => ({ ...b, i }))
    .sort((a, b) => a.minGap - b.minGap);
  const holes = [];
  for (let n = 1; n < sorted.length; n++) {
    const prev = sorted[n - 1];
    const cur = sorted[n];
    if (prev.maxGap === null) continue;
    if (cur.minGap > prev.maxGap) holes.push([prev.maxGap, cur.minGap]);
  }
  return holes;
}

/** 一個差距落在哪一段 → 追加多少。跟引擎同一套語義（照陣列順序取第一個命中的）。 */
function rlExtraFor(bands, gap) {
  for (const b of bands) {
    if (!Number.isFinite(b.minGap)) continue;
    if (gap < b.minGap) continue;
    if (b.maxGap !== null && gap > b.maxGap) continue;
    return b.extraCost;
  }
  return 0;
}

function rlNum(v) {
  return v === null || v === undefined || Number.isNaN(v) ? "" : String(v);
}

/** 警告區塊的內容（重疊、縫隙）。改一格數字要立刻跟著變。 */
function rlWarnHtml(bands) {
  const issues = rlIssues(bands);
  const holes = rlHoles(bands);
  return (
    (issues.length > 0
      ? `<div class="hint warn">⚠ ${issues.map(esc).join("<br />⚠ ")}</div>`
      : "") +
    (holes.length > 0
      ? `<div class="hint warn">⚠ 這幾段之間有縫隙：${holes
          .map(([a, b]) => `${a} ~ ${b}`)
          .join("、")}。<br />
           整數差距不會掉進去，但<b>小數會</b> —— 角色 COST 只要有一個 13.2，
           差距就是小數，落在縫隙裡就是<b>完全不罰</b>，而且沒有任何提示。
           按上面那顆會把每一段的上界頂到下一段起點的前 0.01。</div>`
      : "")
  );
}

/** 試算表：差距 0~29 各追加多少。 */
function rlPreviewHtml(bands) {
  return (
    `<div class="egrid c10" style="margin-top:6px">
       ${Array.from({ length: 30 }, (_, g) => `<div class="slot">${g}</div>`).join("")}
     </div>` +
    `<div class="egrid c10">
       ${Array.from({ length: 30 }, (_, g) => {
         const x = rlExtraFor(bands, g);
         return `<div class="ecell"><input type="text" readonly class="${
           x > 0 ? "dirty" : ""
         }" value="${x === 0 ? "" : `+${x}`}" /></div>`;
       }).join("")}
     </div>`
  );
}

/**
 * 改一格數字之後把**衍生的那幾塊**重畫。
 *
 * ⚠ **不能整頁重畫。** `renderBody()` 是換掉 `#content` 的 innerHTML，
 * 玩家正在打字的那個輸入框會連同焦點一起消失 —— 每按一個鍵就要重新點一次。
 * 編輯 COST 那一頁踩過同一件事（700 個欄位），這裡只是欄位少而已。
 */
function rlRefresh() {
  if (rl === null) return;
  const warn = $("rlWarn");
  if (warn) warn.innerHTML = rlWarnHtml(rl.bands);
  const preview = $("rlPreview");
  if (preview) preview.innerHTML = rlPreviewHtml(rl.bands);
  const dirty = rlDirty();
  const save = $("rlSave");
  if (save) save.disabled = !dirty || rlIssues(rl.bands).length > 0;
  const cell = $("rlDirtyCell");
  if (cell) {
    cell.innerHTML = dirty
      ? '<b class="warn">有改動</b>'
      : '<span class="dim">沒有，都存好了</span>';
  }
}

PAGES["rule/ruleedit"] = () => {
  const title = head(
    "編輯規則",
    "改規則檔裡<b>不是價格</b>的那一半。目前是壓 C —— 差距多少罰多少，一段一排。",
  );
  if (rl === null) {
    rlLoad(false);
    return title + `<div class="card"><div class="hint">載入中…</div></div>`;
  }
  if (rl.rule === null) {
    return (
      title +
      `<div class="card">
         <div class="row"><span class="dim">規則</span><span class="bad"><b>還沒選</b></span></div>
         <div class="hint">編輯規則是<b>改一份既有的規則檔</b>，所以要先有檔案。
           到「自訂COST › Cost 表」選一份 —— 沒有自己的規則就先選
           <code>unlight-official</code>，那份的壓 C 就是原版的兩段。</div>
       </div>`
    );
  }

  const bands = rl.bands;
  const issues = rlIssues(bands);
  const dirty = rlDirty();

  const header = `<div class="card">
       <div class="row"><span class="dim">正在編輯</span>
         <span><b>${esc(rl.rule.name)}</b>
           <input type="text" id="rlVersion" value="${esc(rl.rule.version)}" style="width:5.5em;margin-left:6px" />
         </span></div>
       <div class="row"><span class="dim">檔案</span><span>${esc(rl.rule.fileName)}</span></div>
       <div class="row"><span class="dim">壓 C</span><span>${
         bands.length === 0 ? '<span class="dim">這份規則不壓 C</span>' : `${bands.length} 段`
       }</span></div>
       <div class="row"><span class="dim">未存檔</span><span id="rlDirtyCell">${
         dirty ? '<b class="warn">有改動</b>' : '<span class="dim">沒有，都存好了</span>'
       }</span></div>
       <div class="presets" style="margin-top:8px">
         <button id="rlSave" ${dirty && issues.length === 0 ? "" : "disabled"}>存回這個檔</button>
         <button id="rlOfficial">改回原版兩段</button>
         <button id="rlClear" class="danger">清空（不壓 C）</button>
       </div>
       ${rlMsg ? `<div class="hint ${rlMsg.bad ? "warn" : "good"}">${esc(rlMsg.text)}</div>` : ""}
       <div class="hint">存檔會<b>就地覆寫同一個檔</b>，核對碼重算 ——
         跟「編輯 COST」是同一個檔案的兩半，兩邊互不影響。
         <b>要傳給對手之前記得改版本號</b>（上面那格）。<br />
         ⚠ 存檔後壓 C 與價格都<b>當場生效</b>，不用重載遊戲。</div>
     </div>`;

  const rows = bands
    .map(
      (b, i) => `<div class="bandrow">
         <span class="lbl">${i + 1}.</span>
         <span class="lbl">差距</span>
         <input type="number" step="0.01" data-rb="${i}" data-rf="minGap" value="${esc(rlNum(b.minGap))}" />
         <span class="lbl">～</span>
         <input type="number" step="0.01" data-rb="${i}" data-rf="maxGap" value="${esc(rlNum(b.maxGap))}" placeholder="無上界" />
         <span class="lbl">追加</span>
         <input type="number" step="0.01" data-rb="${i}" data-rf="extraCost" value="${esc(rlNum(b.extraCost))}" />
         <button data-rbdel="${i}" title="刪掉這一段">✕</button>
       </div>`,
    )
    .join("");

  const table = `<div class="card">
       <div class="row"><span class="dim">壓 C 區間</span>
         <span class="dim">上界留空＝無上界</span></div>
       ${
         bands.length === 0
           ? `<div class="hint">一段都沒有 —— 這份規則<b>完全不壓 C</b>。
                那跟「用原版」是兩回事：原版是 7~13 罰 5、14 以上罰 10。</div>`
           : rows
       }
       <div class="presets">
         <button id="rlAdd">新增一段</button>
         <button id="rlSort">照差距排序</button>
         <button id="rlSnap">把上界頂到下一段（補小數縫隙）</button>
       </div>
       <div id="rlWarn">${rlWarnHtml(bands)}</div>
       <div class="hint">壓 C 是<b>隊內每一對出戰卡</b>各判一次，三張就是三對。
         <b>怪物卡也算</b>（它跟角色共用那三個槽位）；裝備與事件卡計入總和但不參與壓 C。<br />
         遊戲畫面上每張卡底下的 <code>+N</code> 會貼在<b>那一對裡比較便宜的那張</b>
         —— 壓 C 罰的就是被夾帶進來的低 C 卡。三格的和等於總罰則。</div>
     </div>`;

  // 對照表：一眼看出這條曲線長什麼樣。
  const preview = `<div class="card">
       <div class="row"><span class="dim">試算</span><span class="dim">差距 → 追加</span></div>
       <div id="rlPreview">${rlPreviewHtml(bands)}</div>
       <div class="hint">上排是<b>兩張卡的 COST 差距</b>，下排是這條曲線要追加多少。
         空白＝不罰。小數差距請看上面的縫隙警告 —— 這張表只列整數。</div>
     </div>`;

  return title + header + table + preview;
};

// --- 自訂COST › 編輯描述 -----------------------------------------------
//
// 規則檔的第三半：不是價格、也不是壓 C 的那些欄位 —— 名字、作者、版本、
// 適用範圍、更新說明。
//
// ⚠ **每一個欄位都會進 contentHash。** 整個 rule 物件就是雜湊的對象，所以
// 改個作者名字核對碼就會變，而核對碼正是玩家拿去跟對手核對的東西。這件事
// 一定要寫在畫面上，否則會有人以為「只有數字算數」。
//
// ⚠ `restrictions`（限制條款）**不在這裡**：schemaVersion 1 的它是
// `agreement-only` 的自由文字，引擎永遠不解析（§12）。做一個編輯器給一個
// 沒有任何行為的欄位，只會讓人以為插件會強制它。

let rd = null;
let rdMsg = null;
let rdLoading = false;
const onDescPage = () => tab === "rule" && sub === "ruledesc";

const RD_FIELDS = [
  {
    key: "name",
    label: "名稱",
    hint: "玩家在「Cost 表」那一頁看到的名字。",
    max: 80,
  },
  {
    key: "version",
    label: "版本",
    hint: "SemVer（<code>1.2.0</code>）。⚠ <b>發出去過的版本號不要重用</b> —— 對手手上那份會頂著同樣的號碼、不同的內容。",
    max: 20,
  },
  {
    key: "ruleSetId",
    label: "規則族",
    hint: "<code>作者代號/規則代號</code>，只能小寫英數與連字號。⚠ <b>配對是照這個分隊的</b>：改了它，你就跟原本那條隊伍上的所有人分開了。",
    max: 79,
  },
  {
    key: "publisherId",
    label: "作者代號",
    hint: "⚠ 必須跟「規則族」的<b>前半段一模一樣</b>，不然存不進去（那是作者歸屬的依據）。",
    max: 39,
  },
  { key: "publisherName", label: "作者名稱", hint: "顯示用的名字，中文可以。", max: 60 },
  {
    key: "publisherContact",
    label: "聯絡方式",
    hint: "選填。Discord 之類，讓拿到規則的人找得到你。",
    max: 120,
  },
  {
    key: "gameVersion",
    label: "遊戲版本",
    hint: "這份表是照哪一版的遊戲做的，格式 <code>2026.08</code>。",
    max: 7,
  },
];

function rdLoad(force) {
  if (rdLoading) return;
  if (rd !== null && !force) return;
  rdLoading = true;
  window.ulr.editor.load().then((payload) => {
    rdLoading = false;
    rd = {
      rule: payload.rule,
      meta: payload.meta ? { ...payload.meta } : null,
      saved: payload.meta ? JSON.stringify(payload.meta) : null,
    };
    if (onDescPage()) renderBody();
  });
}

function rdDirty() {
  return rd?.meta !== null && JSON.stringify(rd?.meta) !== rd?.saved;
}

PAGES["rule/ruledesc"] = () => {
  const title = head("編輯描述", "規則檔裡<b>不是數字</b>的那些欄位 —— 名字、作者、版本、說明。");
  if (rd === null) {
    rdLoad(false);
    return title + `<div class="card"><div class="hint">載入中…</div></div>`;
  }
  if (rd.meta === null) {
    return (
      title +
      `<div class="card">
         <div class="row"><span class="dim">規則</span><span class="bad"><b>還沒選</b></span></div>
         <div class="hint">要先有檔案才改得動。到「自訂COST › Cost 表」選一份 ——
           沒有自己的規則就先選 <code>unlight-official</code>，改完它就是你的版本了。</div>
       </div>`
    );
  }

  const m = rd.meta;
  const dirty = rdDirty();

  const rows = RD_FIELDS.map(
    (fd) => `<div class="row"><span class="dim">${esc(fd.label)}</span>
         <span><input type="text" data-rd="${fd.key}" maxlength="${fd.max}"
                value="${esc(m[fd.key] ?? "")}" style="width:16em" /></span></div>
       <div class="hint">${fd.hint}</div>`,
  ).join("");

  const appliesOpts = [
    ["duel", "duel（約戰）"],
    ["quest", "quest（任務）"],
    ["any", "any（都可以）"],
  ]
    .map(
      ([v, label]) =>
        `<option value="${v}"${m.appliesTo === v ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");

  return (
    title +
    `<div class="card">
       <div class="row"><span class="dim">檔案</span><span>${esc(rd.rule.fileName)}</span></div>
       <div class="row"><span class="dim">目前核對碼</span><span>${
         rd.rule.shortHash
           ? `<code>${esc(rd.rule.shortHash)}</code>`
           : '<span class="dim">裸規則，沒有核對碼</span>'
       }</span></div>
       <div class="row"><span class="dim">未存檔</span><span id="rdDirtyCell">${
         dirty ? '<b class="warn">有改動</b>' : '<span class="dim">沒有，都存好了</span>'
       }</span></div>
       <div class="presets" style="margin-top:8px">
         <button id="rdSave" ${dirty ? "" : "disabled"}>存回這個檔</button>
       </div>
       ${rdMsg ? `<div class="hint ${rdMsg.bad ? "warn" : "good"}">${esc(rdMsg.text)}</div>` : ""}
       <div class="hint">⚠ <b>這一頁的每個欄位都會改變核對碼</b> ——
         整份規則（含名字與作者）就是雜湊的對象。改完記得把檔案傳給對手，
         不然兩邊核對碼對不起來。</div>
     </div>
     <div class="card">
       ${rows}
       <div class="row"><span class="dim">適用範圍</span>
         <span><select data-rd="appliesTo">${appliesOpts}</select></span></div>
       <div class="hint">給人看的宣告，引擎不會拿它擋任何事。</div>
       <div class="row"><span class="dim">隊伍 COST 上限</span>
         <span><input type="number" step="0.01" min="0" data-rd="teamCostLimit"
                value="${esc(String(m.teamCostLimit))}" style="width:6em" /></span></div>
       <div class="hint"><b>0 = 不設限</b>，而那是正常的 —— UNLIGHT 的 COST 上限是
         <b>伺服器按頻道下發</b>的，客戶端裡根本沒有這個常數。
         <b>快速比賽的檔位也不看這一格</b>，它是照牌組算的。</div>
     </div>
     <div class="card">
       <div class="row"><span class="dim">說明</span></div>
       <textarea data-rd="description" rows="4" maxlength="2000"
         style="width:100%">${esc(m.description ?? "")}</textarea>
       <div class="hint">這份規則想解決什麼問題。清空就是「沒有說明」。</div>
       <div class="row" style="margin-top:10px"><span class="dim">更新說明</span></div>
       <textarea data-rd="changelog" rows="4" maxlength="2000"
         style="width:100%">${esc(m.changelog ?? "")}</textarea>
       <div class="hint">這一版改了什麼。拿到規則的人靠它知道要不要跟著更新。</div>
     </div>`
  );
};

// --- 自訂COST › 對戰地點 -----------------------------------------------
//
// ⚠⚠ **這一頁曾經是「自動配對」，整整六張卡。** 排隊狀態、頻道資訊、兩份
// COST 對照、開房設定、規則卡、房間清單 —— 要滑三個畫面才看得完，而玩家
// 坐下來只想按一顆按鈕打一場。
//
// 那一整套搬回遊戲裡了：WP-17 在迪城大廳畫的那顆「快速比賽」跟亞城那顆
// 長得一樣，人數、等待視窗、錯誤對話框全都是遊戲自己的。托盤這邊只留下
// **遊戲裡按不到的那一格**：這一場開在哪。
//
// ⚠ **這一頁不輪詢，也沒有任何會操作遊戲的東西。** 它讀快照、寫設定檔，
// 就這樣。
//
// ⚠ 長話一律進 ⓘ（`info()`）。留在畫面上的只有「你現在選的這個會怎樣」
// 那一句 —— 玩家是來放鬆的，一頁的字要一眼看得完。

/**
 * 畫面上還沒被下一份快照蓋回去的那一格。
 *
 * ⚠ 真實來源是設定檔（`snap.profile.match`）。這裡留一份是因為 `select`
 * 的 change 與快照回來之間隔著一趟 IPC —— 中間重畫一次的話選單會彈回舊值。
 */
let mform = null;

/** 認得的地點代號 → 「007 峰亥盧遺跡」。清單從主程序來（見 `Snapshot`）。 */
function stageName(value) {
  const hit = (snap?.selectableStages ?? []).find((g) => g.value === value);
  return hit ? `${hit.value} ${hit.name}` : String(value);
}

// ⚠ 這三段是**這一頁唯一的長文**，而它們住在 `title=` 裡。畫面上看得到的
// 字要短到一眼看完；要細節的人按 ⓘ。
const STAGE_TIP =
  "優先權：亞城隨機 ＞ 官方隨機 ＞ 指定的地圖\n" +
  "· 一個人選亞城隨機 → 整場走亞城隨機\n" +
  "· 沒人選亞城隨機、有人選官方隨機 → 官方隨機\n" +
  "· 兩邊各指定一張且不一樣 → 擲骰子二選一\n" +
  "\n" +
  "亞城池是官方選單的 000～009 再加上 011（魔女山谷）。011 在官方開房選單裡選不到，" +
  "插件只驗過客戶端有它的背景圖，沒有在上面打完一整場。\n" +
  "⚠ 選官方隨機或指定地圖也躲不掉它 —— 對手選亞城隨機時整場就走亞城池。";

const PICK_TIP =
  "開房的只有一方，所以「我指定 007」對另一邊永遠是被決定的。\n" +
  "兩邊指同一張就開那一張；指不同張時擲骰子二選一 —— 那是唯一不偏袒任何一方的解法。";

const AUTO_TIP =
  "檔位照你的牌組算，你填不到，也不必填：\n" +
  "· 落在這個頻道的官方檔位裡 → 就是那一檔（跟亞城一樣）\n" +
  "· 落在外面 → 這副牌自己那一檔，一檔寬 1.00C 而且有下限（壓 C 才有意義）\n" +
  "· 自訂檔在大廳左下沒有官方的那一行，插件會另外加一列（前面有 ★），沒人在等就不畫\n" +
  "· 排隊中那個等待視窗上會寫著你排的是哪一檔\n" +
  "\n" +
  "房名由系統取（規則名 + [COST:n]），玩家改不了 —— 大廳裡的人要一眼看得出是哪一檔。\n" +
  "固定 3vs3、固定不設遊戲自己的「牌組Cost限制 ±N」。\n" +
  "\n" +
  "⚠ 配到人會直接消耗 AP 並開打。再按一次那顆按鈕就是取消。\n" +
  "⚠ 排隊時每 5 秒確認你還在那個頻道：跑去打別場、退出頻道、換頻道都會自動停止排隊。";

const COST_IN_GAME_TIP =
  "關著時規則照樣載著，自動配對照樣用它算檔位；只是遊戲畫面上不套：\n" +
  "· 迪特赫姆的卡片價格、壓 C 罰則、牌盒與房間的 cost 都是官方的\n" +
  "· 牌組編輯標題列那顆「自訂 ↔ 官方」開關不畫\n" +
  "\n" +
  "切換當場生效，不必重載遊戲。";

PAGES["rule/match"] = () => {
  const stage = mform?.stage ?? snap?.profile?.match?.stage ?? "arcadia";

  // ⚠ **選單的順序就是協商的優先權**（見 `@ulr/arbiter-engine` 的
  // `negotiateStage`）。兩者不一致的話這個選單會騙人：玩家會以為排在最
  // 上面的只是「預設」，而它其實是「一個人選就整場照它走」。
  const opts = [
    ["arcadia", "亞城隨機（插件從 11 張裡抽）"],
    ["official", "官方隨機（交給伺服器抽）"],
    ...(snap?.selectableStages ?? []).map((g) => [g.value, `${g.value} ${g.name}`]),
  ]
    .map(
      ([v, label]) =>
        `<option value="${esc(v)}"${stage === v ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");

  // 選了這個會怎樣，一句話。⚠ 指定某一張時一定要接那句「對手也要選同一張」
  // —— 少了它，玩家會以為自己選的就是這一場的地點。
  const line =
    stage === "arcadia"
      ? "插件從亞城那 11 張裡抽一張。"
      : stage === "official"
        ? "交給遊戲伺服器抽。"
        : `想開在 ${esc(stageName(stage))}。<b>對手也要選同一張才一定開得成</b>${info(PICK_TIP)}`;

  // 遊戲畫面套不套自訂 COST（Profile.customCostInGame）。預設關。
  const inGame = snap?.profile?.customCostInGame === true;

  return (
    head("對戰地點", "配到人之後，這一場開在哪。") +
    `<div class="card">
       <label class="toggle">
         <input type="checkbox" id="costInGameOn" ${inGame ? "checked" : ""} />
         <span><b>遊戲裡套用自訂 COST</b>${info(COST_IN_GAME_TIP)}
           <div class="hint">${
             inGame
               ? "迪特赫姆用自訂 COST；牌組編輯標題列有「自訂 ↔ 官方」開關。"
               : "迪特赫姆、牌組編輯都是官方 COST，也不顯示切換開關。"
           }</div>
         </span>
       </label>
     </div>
     <div class="card">
       <div class="row"><span class="dim">對戰地點</span>
         <span><select id="mStage">${opts}</select>${info(STAGE_TIP)}</span></div>
       <div class="hint">${line}</div>
     </div>
     <div class="card">
       <div class="row"><span class="dim">怎麼開始一場</span>
         <span>在遊戲裡按<b>快速比賽</b></span></div>
       <div class="hint">迪特赫姆與布萊德克洛伊茲的大廳有一顆<b>快速比賽</b> ——
         那是插件放的，跟亞歷山卓城那顆一樣：按下去排隊，配到用同一套規則的人就
         自動開房、自動開打。檔位、房名、3vs3 都是自動的${info(AUTO_TIP)}</div>
     </div>`
  );
};
