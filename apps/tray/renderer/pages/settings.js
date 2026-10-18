// 設置 › 連線／配置／網頁版／啟動／記錄／關於。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 設置 › 連線 ------------------------------------------------------
/**
 * 「怎麼讓插件接得到遊戲」——**一行字加一顆複製按鈕，就這樣。**
 *
 * ⚠ **這一段以前有 5 個步驟加 4 條警告，那是寫給我自己看的，不是寫給玩家的。**
 * 玩家要的不是理解 CDP，是知道下一步按哪裡。那 4 條警告全部是「填固定埠時
 * 才會出事」的排錯知識 —— 改成叫大家填 `0` 之後，那些情況一個都不會發生，
 * 於是整段可以刪掉，而不是折疊起來。**指示變短的正確方式是讓它變得不必要。**
 *
 * 剩下的排錯（埠被保留、被別的程式佔走、asar 是網頁版）由
 * `explainDebugPort()` 在真的出事時講一句，而且是講**那一次**的原因 ——
 * 比預先把四種可能都攤在玩家面前準。
 *
 * ⚠ **瀏覽器（Chrome／Edge）走另一條。** 網頁版玩家是用 Steam 登入擴充開遊戲的
 * （2026-10-15 起取代書籤＋竄改猴／ULR Boot），那條路本身不需要除錯埠 —— 插件需要。所以給的是
 * 「用專用設定檔帶除錯埠開瀏覽器」，不是 Steam 啟動選項（Steam 的網頁版
 * 啟動器會把參數吃掉，見 docs）。判斷寫成「不是桌面版」而不是列舉瀏覽器，
 * 這樣以後多一種瀏覽器也不會落到 Steam 那段去。
 *
 * ⚠ 說明只講**做什麼**，不猜玩家是誰、為什麼用網頁版。
 */
function howToConnect(p) {
  if (p && p.kind !== "desktop") return browserConnect(p);
  return `<div class="card">
     <div class="row"><span><b>接不上遊戲？</b></span></div>
     <div class="hint">在 Steam 的啟動選項填這一行，然後重開遊戲：</div>
     <div class="row">
       <code>${esc(snap?.debugFlag ?? "")}</code>
       <button id="copyFlag">複製</button>
     </div>
   </div>`;
}

/**
 * 開瀏覽器／存 .cmd／放擴充 的結果。按鈕旁邊講一句，不跳對話框。
 * `at` = 講在哪一張卡底下（網頁版那頁有好幾張卡都有按鈕，只講在按的那張）。
 */
let webMsg = null;
const webMsgLine = (at = null) =>
  webMsg && (webMsg.at ?? null) === at
    ? `<div class="hint${webMsg.bad ? " warn" : ""}">${esc(webMsg.text)}</div>`
    : "";

function browserConnect(p) {
  const name = kindText(p.kind);
  const guide = snap?.steamExt?.guideUrl ?? "";
  return `<div class="card">
       <div class="row"><span><b>開 ${esc(name)}</b></span>
         <span><button id="browserOpen">開啟</button> <button id="browserCmd">存成 .cmd</button></span></div>
       <div class="hint">用插件專用的設定檔開，帶 <code>--remote-debugging-port=0</code>。
         遊戲在這個視窗裡開，插件就接得上。</div>
       ${webMsgLine()}
     </div>
     <div class="card">
       <div class="row"><span><b>在瀏覽器裡開遊戲</b></span></div>
       <div class="hint">這個設定檔是獨立的，要在裡面裝一次 Steam 登入擴充、登入 Steam 帳號。</div>
       <div class="row"><span>Steam 登入擴充</span><span>
         <button data-goto="web">設置 › 網頁版</button> <button data-link="${esc(guide)}">安裝說明</button></span></div>
     </div>`;
}

// --- 設置 › 配置 ------------------------------------------------------
//
// ⚠ 這一頁的表格、IPC（window.ulr.profiles.*）與按鈕事件本來就在了，
// 缺的一直是這支 render 函式 —— 分頁註冊了但 PAGES 沒有對應的鍵，
// renderBody() 就畫出一片空白。空白頁不會報錯，所以很難發現。
PAGES["settings/profiles"] = () => {
  const list = snap?.store.profiles ?? [];
  const meId = snap?.profile.id;
  const alives = snap?.gameAlive ?? {};
  // ⚠ 同一種客戶端只能有一份（profiles-core 的 kindTaken）：同種的兩份讀同一個
  // DevToolsActivePort，會接上同一個遊戲。舊設定檔可能已經有重複的 —— 標出來。
  const kindCount = {};
  for (const p of list) kindCount[p.kind] = (kindCount[p.kind] ?? 0) + 1;
  const allKindsUsed = Object.keys(KIND_TEXT).every((k) => kindCount[k] > 0);

  const row = (p) => {
    const self = p.id === meId;
    // ⚠ 別份配置只敢說「那個客戶端有沒有在回話」。一個視窗只管一個
    // 客戶端，它沒辦法知道另一份配置的插件狀態。
    const alive = alives[p.id];
    const state =
      kindCount[p.kind] > 1
        ? `跟別份都是${KIND_TEXT[p.kind] ?? p.kind}，會接到同一個遊戲`
        : self
          ? snap?.status?.connected
            ? "這個視窗（已接上）"
            : "這個視窗（等遊戲…）"
          : alive === true
            ? "遊戲開著"
            : alive === false
              ? "沒有回應"
              : "—";
    // ⚠ 中間人那一列拿掉了（玩家 2026-10-04）：一律是雲端，畫面上不給改。
    // 輸入與按鈕的事件都是 closest("tr[data-id]") 找配置。
    const cls = self ? " self" : "";
    return `<tr data-id="${esc(p.id)}" class="${cls.trim()}">
        <td><input type="text" data-field="name" value="${esc(p.name)}" /></td>
        <td><select data-field="kind">
              ${Object.entries(KIND_TEXT)
                .map(
                  ([k, label]) =>
                    `<option value="${k}"${p.kind === k ? " selected" : kindCount[k] > 0 ? " disabled" : ""}>${label}</option>`,
                )
                .join("")}
            </select></td>
        <td class="state">${esc(state)}</td>
        <td class="acts">
          ${self ? "" : `<button data-act="launch">開新實例</button>`}
          ${allKindsUsed ? "" : `<button data-act="dup">複製</button>`}
          ${list.length > 1 && !self ? `<button data-act="del">刪除</button>` : ""}
        </td>
      </tr>`;
  };

  const table = list.length
    ? `<table class="profiles">
         <thead><tr><th>名稱</th><th>客戶端</th><th>狀態</th><th></th></tr></thead>
         <tbody>${list.map(row).join("")}</tbody>
       </table>`
    : `<div class="hint">清單是空的。按下面的「新增配置」建一份 ——
         第一份預設是桌面版，第二份會自動變成 Chrome。
         要接 Edge 的話在「客戶端」那一格改成 Edge 即可（它有自己的
         瀏覽器 profile，跟 Chrome 可以同時開）。</div>`;

  return (
    head("配置", "一個視窗管一個遊戲客戶端。要同時管兩個就建兩份配置，各開一個實例。") +
    `<div class="card">
       ${table}
       ${allKindsUsed ? "" : `<div class="row"><span></span><span><button id="addProfile">新增配置…</button></span></div>`}
       <!--
         ⚠ 埠那一欄 2026-10-10 拿掉了：標準作業流程是 --remote-debugging-port=0，
         插件只讀客戶端自己寫的 DevToolsActivePort。留下的兩行是「不知道就會
         卡住」的：換客戶端不重開沒有反應（引擎綁在啟動時的客戶端上）、
         同一種只能一份（下拉選單裡別份用掉的那幾種是灰的）。
       -->
       <div class="hint">
         ⚠ 改客戶端要<b>重開那個實例</b>才生效。<br />
         ⚠ 同一種客戶端只能有一份 —— 兩份會接到<b>同一個遊戲</b>。
       </div>
     </div>` +
    (snap?.ephemeral
      ? `<div class="card"><div class="hint warn" style="margin-top:0">
           這個視窗是命令列開的臨時配置${snap.profile.cliPort ? `（<b>:${snap.profile.cliPort}</b>）` : ""}，<b>不在清單裡</b>。
           改它的設定不會存下來 —— 要留著就按上面的「新增配置」。
         </div></div>`
      : "")
  );
};

/**
 * 這份配置接哪一種客戶端。換了插件會自己重開（引擎綁在啟動時的客戶端上）。
 *
 * ⚠ 命令列開的臨時配置不給換：它不在清單裡，重開會落到別份配置上。
 */
function clientKindRow(p) {
  if (!p) return "";
  // 別份配置已經是那一種的不給選（同一種客戶端只能有一份）。
  const taken = new Set(
    (snap?.store.profiles ?? []).filter((o) => o.id !== p.id).map((o) => o.kind),
  );
  const opts = Object.entries(KIND_TEXT)
    .map(
      ([k, label]) =>
        `<option value="${k}"${p.kind === k ? " selected" : taken.has(k) ? " disabled" : ""}>${label}</option>`,
    )
    .join("");
  return `<div class="row"><span class="dim">客戶端</span>${
    snap?.ephemeral
      ? `<span>${esc(kindText(p.kind))}</span>`
      : `<select id="clientKind" title="換了之後插件會重開一次">${opts}</select>`
  }</div>`;
}

/**
 * ⚠ **這一頁只回答一個問題：插件跟遊戲接上了沒。**（玩家 2026-10-04 指定精簡）
 *
 * 拿掉的東西都有別的地方看得到，或只是排錯用的：
 *   分頁標題、攔截已掛上、側通道 → 狀態列與 戰鬥 › 準備 已經講了
 *   CDP 埠、中間人、我是中間人   → 設置 › 配置 的表格裡有，狀態列最後一句也會報錯
 *
 * 「怎麼接上」的教學**只在還沒接上時出現** —— 接上了還掛著兩張說明卡，
 * 玩家會以為自己哪裡沒做完。
 */
PAGES["settings/link"] = () => {
  const st = snap?.status;
  const p = snap?.profile;
  const connected = st?.connected === true;
  return (
    head("連線", "插件跟遊戲接上了沒。") +
    `<div class="card">
       <div class="row"><span class="dim">遊戲</span><span class="${
         connected ? "good" : "warn"
       }">${!st ? "啟動中…" : connected ? "已接上" : "等遊戲…"}</span></div>
       ${clientKindRow(p)}
       ${st?.error ? `<div class="hint warn">⚠ ${esc(st.error)}</div>` : ""}
     </div>
     ${connected ? "" : howToConnect(p)}`
  );
};

// --- 設置 › 網頁版 ----------------------------------------------------
/**
 * 用瀏覽器玩的整套，照玩家要做的順序排：① 帶除錯埠的瀏覽器 ② Steam 登入擴充 ③ 登入。
 *
 * ① 的捷徑目標是主程序照**這台機器**組出來的（`snap.browsers`：找到的執行檔＋
 * 這個人的家目錄），跟「開啟」按鈕、「建桌面捷徑」寫進 .lnk 的是同一行 ——
 * 玩家照抄的、按鈕開的、捷徑開的永遠是同一個瀏覽器同一個設定檔。
 *
 * 擴充原始檔跟著安裝包走，按一下放到固定的資料夾（`snap.steamExt.dir`）——
 * 之後插件更新時再按一次就是原地更新。
 *
 * ⚠ 2026-10-15 起官方驗 access_token，ULR Boot／竄改猴的「只帶 steamid 直開」登不進去。
 * 這個擴充是在瀏覽器裡登入 Steam 帳號、每次開遊戲向 Steam 拿一顆新 token。
 * 擴充認得舊的 `?steamid=` 書籤，所以玩家原本的書籤不用換。
 */
PAGES["settings/web"] = () => {
  const b = snap?.steamExt;
  const br = snap?.browsers ?? {};
  const stale = b?.installed && b?.bundled && b.installed !== b.bundled;
  const action = !b?.installed ? "放好" : stale ? `更新到 ${b.bundled}` : "重新放一次";
  const fams = [
    ["chrome", "Chrome"],
    ["edge", "Edge"],
  ];
  const openRows = fams
    .map(([f, name]) =>
      br[f]?.exe
        ? `<div class="row"><span>${name}</span><span>
             <button data-browser="${f}">開啟</button>
             <button data-shortcut="${f}">建桌面捷徑</button></span></div>`
        : `<div class="row"><span>${name}</span><span class="dim">沒找到</span></div>`,
    )
    .join("");
  const targets = fams
    .filter(([f]) => br[f]?.target)
    .map(
      ([f, name]) =>
        `<div class="row"><span>${name}</span><span><button data-copytarget="${f}">複製</button></span></div>
         <code class="line">${esc(br[f].target)}</code>`,
    )
    .join("");
  return (
    head("網頁版", "用瀏覽器玩，插件一樣接得上。") +
    `<div class="card">
       <div class="row"><span><b>① 帶除錯埠的瀏覽器</b></span></div>
       <div class="hint">插件靠除錯埠接遊戲。這裡開的是專用設定檔，跟你平常的瀏覽器分開 ——
         書籤、登入、擴充各一份，平常那個不用關也不受影響。</div>
       ${openRows}
       ${webMsgLine("browser")}
       <div class="hint">建好的捷徑叫「ULR Chrome」「ULR Edge」，之後雙擊它就好，不用先開插件。
         Edge 開的時候會順便掛上 Steam 登入擴充（②放好的話）。</div>
     </div>
     <div class="card">
       <div class="row"><span><b>自己做捷徑</b></span></div>
       <ol class="steps">
         <li>桌面按右鍵 › 新增 › 捷徑</li>
         <li>「項目位置」貼上下面那一行（已經照你這台電腦填好）</li>
         <li>名字隨便取，按完成</li>
       </ol>
       ${targets || `<div class="hint warn">沒找到 Chrome 或 Edge。</div>`}
       ${webMsgLine("copy")}
       <div class="hint">⚠ 只在平常那個瀏覽器的捷徑後面加 <code>--remote-debugging-port=0</code> 沒用：
         Chrome 136 起預設設定檔不開除錯埠，而且瀏覽器開著時再點只會多開視窗、參數整串被丟掉。
         一定要連 <code>--user-data-dir</code> 一起。</div>
     </div>
     <div class="card">
       <div class="row"><span><b>② Steam 登入擴充</b></span></div>
       <div class="hint">在瀏覽器裡用 Steam 帳號登入遊戲，不用開 Steam 用戶端。插件內建，不用另外下載。</div>
       <div class="row"><span class="dim">資料夾</span><span><code>${esc(b?.dir ?? "—")}</code></span></div>
       <div class="row"><span class="dim">版本</span><span>${
         b?.installed ? esc(b.installed) : "還沒放"
       }</span></div>
       <div class="row"><span></span><span><button id="steamExtInstall">${esc(action)}</button></span></div>
       ${webMsgLine("ext")}
       <ol class="steps">
         <li>按上面的「${esc(action)}」，資料夾會打開</li>
         <li>開擴充功能頁：
           <button data-extpage="chrome">Chrome</button> <button data-extpage="edge">Edge</button>
           ，右上角打開「開發人員模式」</li>
         <li>「載入未封裝項目」→ 選那個資料夾</li>
       </ol>
       <div class="hint">Edge 用 ① 的按鈕或捷徑開會自動掛上，可以跳過 2、3 步。<br />
         <b>更新</b>：插件更新後這裡會出現「更新到 …」，按它，再到擴充功能頁按 ⟳。<br />
         ⚠ 裝過 <b>ULR Boot</b> 或竄改猴的 ulr_steam 腳本的話，先在擴充功能頁把它們移除／停用 ——
         10/15 改版後它們登不進去，留著會跟新的搶。</div>
     </div>
     <div class="card">
       <div class="row"><span><b>③ 登入 Steam、開遊戲</b></span></div>
       <ol class="steps">
         <li>點瀏覽器右上角的擴充圖示（拼圖裡的「UNLIGHT:Revive Steam 登入」）→「新增帳號」</li>
         <li>填 Steam 帳號名稱（不是 Email）和密碼；Steam 要驗證碼就照它問的填</li>
         <li>之後點擴充圖示裡的帳號就開遊戲。想用書籤的話，在「管理帳號」按「複製連結」存起來</li>
       </ol>
       <div class="hint">密碼只會加密送給 Steam，擴充不存密碼。以前存的
         <code>?steamid=</code> 書籤照樣能用，第一次點會要你登入那個帳號。<br />
         詳細說明（含手機版）：<button data-link="${esc(b?.guideUrl ?? "")}">安裝說明</button></div>
     </div>`
  );
};

// --- 設置 › 啟動 ------------------------------------------------------
PAGES["settings/startup"] = () => {
  const s = snap?.store;
  return (
    head("啟動", "開機時要不要自己起來。") +
    `<div class="card">
       <label class="toggle">
         <input type="checkbox" id="atLogin" ${snap?.launchAtLogin ? "checked" : ""} ${
           snap?.packaged ? "" : "disabled"
         } />
         <span><b>隨 Windows 開機啟動</b>
           <div class="hint">${
             snap?.packaged
               ? "開機後自動縮到系統匣，不跳視窗。"
               : "⚠ 開發模式下不能設 —— 會把 node_modules 裡的 electron.exe 寫進登錄檔，之後開機跳出空白視窗且很難查。打包後才可用。"
           }</div>
         </span>
       </label>
     </div>
     <div class="card">
       <label class="toggle">
         <input type="checkbox" id="startMin" ${s?.startMinimized ? "checked" : ""} />
         <span><b>啟動時只留托盤圖示</b>
           <div class="hint">不跳設定視窗。點托盤圖示隨時叫得出來。</div>
         </span>
       </label>
     </div>
     <div class="card">
       <div class="hint" style="margin-top:0">
         遊戲要帶除錯埠開，插件才接得上 —— 做法在 <b>設置 › 連線</b>。<br />
         ⚠ 沒帶的話插件<b>永遠</b>接不上，畫面上只會寫「等遊戲…」。
       </div>
     </div>`
  );
};

// --- 設置 › 記錄 ------------------------------------------------------
PAGES["settings/log"] = () =>
  head("記錄", "最近的動作。查「剛剛到底發生了什麼」用的。") +
  `<div class="card"><pre class="log" id="log">${esc(
    (snap?.log ?? []).join("\n") || "（還沒有記錄）",
  )}</pre></div>
   <div class="card">
     <div class="hint" style="margin-top:0">
       這一頁只留最近 40 行，<b>完整記錄寫在檔案裡</b>（關掉插件也還在）：<br />
       <code>${esc(snap?.logPath ?? "—")}</code><br />
       回報問題時請附上它。<b>裡面不含任何遊戲內容</b> —— 沒有手牌、沒有牌組、
       沒有對手是誰，房號也是截短的雜湊，可以直接貼。
     </div>
   </div>`;

// --- 設置 › 關於 ------------------------------------------------------
/**
 * 「會連到哪裡、送什麼」—— **一條連線一列，照實寫，包含預設開著的分享。**
 *
 * ⚠ 這一段以前寫「只有兩個對外連線」「牌組內容不會送出去」，那是 v1 的事實；
 * 之後加了牌組雲端、渦互傳、打渦隊伍、ulgg、配對佇列，這頁沒跟上，變成一份
 * 錯的隱私說明（2026-10-04 玩家要求更新時對著程式碼重查）。**加新的對外連線時
 * 這裡要跟著加一列** —— 連線清單在 `@ulr/arbiter-link/target.ts` 的 SERVICE_ORIGIN
 * 那幾個常數與 `raid-public.ts`（ulgg）。
 *
 * ⚠ **照實際的目的地分組，寫出主機名。**（玩家 2026-10-04）不要寫「中間人」
 * 「雲端」「插件自己的伺服器」—— 玩家看不出那是哪裡，「自己的」還會被讀成
 * 他自己的電腦。
 */
const NET_GROUPS = [
  {
    host: "ulr-link.lldavuull.workers.dev",
    note: "Cloudflare Workers，插件作者架的",
    rows: [
      ["對戰握手", "跟真人對戰時", "雜湊過的場次編號、準備／秒數等對戰偏好", ""],
      ["配對與大廳人數", "在大廳、按下配對後", "配對規則的雜湊鍵", ""],
      ["檢查更新", "每小時", "只問最新版號（插件、預設 COST 表）", ""],
      [
        "牌組跨電腦同步",
        "牌組庫有變動時",
        "牌組庫內容；鍵是角色 id 的雜湊，沒有名字",
        "牌組 › 等候套用",
      ],
      [
        "渦狀態互傳",
        "在渦房時",
        "渦的 stage／HP／狀態；SUPPORT 公開渦的發現者與到期時刻（會發到 Discord 通知）",
        "渦 › 獎勵標記",
      ],
      ["打渦隊伍", "打完渦", "你用的牌組、場數、回合、AP、傷害；名字只傳雜湊", "渦 › 獎勵標記"],
    ],
  },
  {
    host: "ulgg.online",
    note: "第三方的渦查詢網站",
    // ⚠ 讀清單不受互傳開關管（關掉互傳就是「只剩 ulgg」），只有回報 stage 受管。
    rows: [
      [
        "公開渦清單",
        "在渦房時",
        "讀公開渦清單；開著「渦狀態互傳」時，也回報你看到的渦是哪個 stage",
        "",
      ],
    ],
  },
];

/**
 * 「檢查更新」鈕的狀態。`null` = 還沒按過。檢查中按鈕停用，免得連點。
 * 真的有新版而且不在對戰中的話插件會自己重開，這一行字來不及被看到也沒關係。
 */
let updMsg = null;
let updBusy = false;

PAGES["settings/about"] = () =>
  head("關於", "") +
  `<div class="card">
     <div class="row"><span class="dim">ULR Companion</span><span>${esc(snap?.version ?? "—")}</span></div>
     <div class="row"><span class="dim">執行方式</span><span>${
       snap?.packaged ? "已安裝" : "開發模式（未打包）"
     }</span></div>
     <div class="hint">UNLIGHT:Revive 的輔助插件：自訂 COST、牌組庫、渦、對戰準備與秒數。MIT 授權。</div>
     <div class="hint">
       <b>自動更新</b>：每小時檢查一次，下載、驗簽章都在背景完成。
       ⚠ <b>換版一定在對戰之外</b>，換過會留一行記錄。${
         snap?.packaged ? "" : "<br />開發模式不會自動更新。"
       }
     </div>
     <div class="presets">
       <button id="updateCheck"${updBusy || !snap?.packaged ? " disabled" : ""}>${
         updBusy ? "檢查中…" : "檢查更新"
       }</button>
     </div>
     ${updMsg ? `<div class="hint">${esc(updMsg)}</div>` : ""}
     <div class="hint">不想等一小時就按這顆：有新版會下載，不在對戰中就當場換上、插件自己重新啟動。</div>
   </div>
   <div class="card">
     <div class="hint" style="margin-top:0">
       <b>公平性立場</b><br />
       · 不改伺服器的判定，不繞過官方戰鬥規則<br />
       · 替你送出的請求（換牌組、開房、用道具）都是官方畫面本來就能做的<br />
       · 自訂 COST 是<b>自我約束</b>：雙方同意才有意義<br />
       · 不顯示也不上傳對手未揭露的手牌、牌組或任何隱藏資訊<br />
       · 會改變節奏的功能（秒數）一律<b>雙方同意才生效</b>
     </div>
   </div>
   <div class="card">
     <div class="row"><span><b>會連到哪裡、送什麼</b></span></div>
     ${NET_GROUPS.map(
       (g) =>
         `<div class="row" style="margin-top:10px"><span><code>${esc(g.host)}</code></span><span class="dim">${esc(
           g.note,
         )}</span></div>` +
         g.rows
           .map(
             ([name, when, what, off]) =>
               `<div class="row"><span>${esc(name)}</span><span class="dim">${esc(when)}${
                 off ? `　·　關：${esc(off)}` : ""
               }</span></div>
                <div class="hint" style="margin-top:0">${esc(what)}</div>`,
           )
           .join(""),
     ).join("")}
     <div class="hint">
       <b>不會送出去：</b>Steam 帳號、token、密碼；對手的手牌；對戰的勝負。<br />
       連不上時各功能退回只用這台電腦，不會壞。
     </div>
   </div>
   <div class="card">
     <button class="gene" data-link="https://github.com/UnlightPlugin/ulr-companion">原始碼與問題回報</button>
     <button class="gene" data-link="https://ulgg.online/">ULGG</button>
   </div>
   <div class="card">
     <label class="toggle">
       <input type="checkbox" id="multi" ${snap?.store?.multiProfile ? "checked" : ""} />
       <span><b>進階：同時管兩個遊戲客戶端</b>
         <div class="hint">
           平常不需要。<b>一個視窗管一個遊戲</b>，裝好就是這樣，不必設定任何東西。<br />
           打開之後左邊會多一格「配置」（在這一頁下面），托盤選單會多一個「開新實例」，
           狀態列左邊會寫這個視窗是哪一份 —— 那些是給要同時開兩個帳號的人用的。
         </div>
       </span>
     </label>
   </div>`;
