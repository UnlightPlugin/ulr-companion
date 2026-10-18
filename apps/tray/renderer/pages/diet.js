// 迪特赫姆 › 隱藏地圖／物品捷徑／GEM UP／投降。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 迪特赫姆 › 隱藏地圖 -----------------------------------------------
//
// ⚠ 這一頁跟配對頁一樣，狀態**不在 snapshot 裡** —— 它要跟遊戲要一次
// （一次 CDP 往返）。開著才輪詢，離開就停。
let sstate = null;
let stageTimer = null;
const onStagePage = () => tab === "diet" && sub === "hidden";

function startStagePolling() {
  if (stageTimer !== null) return;
  const tick = () =>
    window.ulr.stages.state().then((s) => {
      sstate = s;
      if (!onStagePage()) return;
      // 同配對頁：打字時不重畫，等焦點離開再補（見 `isEditing`）。
      if (isEditing()) {
        scheduleCatchUp();
        return;
      }
      renderBody();
    });
  void tick();
  // 3 秒：這頁唯一會自己變的是「玩家開了一次開房對話框」與「遊戲進大廳了」，
  // 兩件事都不急，但都要在玩家切回來的時候是對的。
  stageTimer = setInterval(tick, 3000);
}
function stopStagePolling() {
  if (stageTimer !== null) clearInterval(stageTimer);
  stageTimer = null;
}

/**
 * 補丁現在到底怎樣，寫成一句人話。
 *
 * ⚠ 這一頁最重要的一件事，是**分清楚「開關打開」跟「遊戲那邊真的變了」**。
 * 中間隔著三段：遊戲有沒有開、有沒有載到對戰大廳、玩家有沒有開過一次開房
 * 對話框。只寫「已啟用」的話，玩家會打開遊戲、發現選單只有 11 項，然後以為
 * 插件壞了。
 */
function stageStatusText(enabled, st) {
  if (!enabled) return "未啟用 —— 遊戲的選單維持官方那 11 項";
  if (st === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!st.installed) {
    return st.waiting ? "等遊戲載到對戰大廳…（不用做任何事，到了就會自己補上）" : "還沒裝上";
  }
  if (!st.dropdownPatched) {
    return "地圖已經加進去了，選單等你在遊戲裡開一次「創建對戰房間」";
  }
  return "生效中";
}

// --- 迪特赫姆 › 物品捷徑 / GEM UP ---------------------------------------
//
// 兩塊都住在物品欄那支注入腳本裡，狀態不在 snapshot 裡，開著才輪詢。
let dstate = null;
let dietTimer = null;
const onDietPage = () =>
  tab === "diet" && (sub === "ditem" || sub === "gemup" || sub === "surrender");

function startDietPolling() {
  if (dietTimer !== null) return;
  const tick = () =>
    window.ulr.diet.state().then((s) => {
      dstate = s;
      if (!onDietPage()) return;
      if (isEditing()) {
        scheduleCatchUp();
        return;
      }
      renderBody();
    });
  void tick();
  dietTimer = setInterval(tick, 3000);
}
function stopDietPolling() {
  if (dietTimer !== null) clearInterval(dietTimer);
  dietTimer = null;
}

function dietItemText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (v.reason) return "沒作用：" + v.reason;
  if (!v.dietStack) return "關著";
  return v.inDiet ? "生效中：迪城上 " + v.dietButtons + " 顆捷徑" : "生效中，等你進迪城";
}
const DIET_SHORTCUT_TIP =
  "按下去走的是官方物品欄「使用」同一條路（同一個請求、用完官方自己重讀物品），插件不多送任何東西。" +
  "官方對水本來就不跳確認框，所以點一下就用掉。數量是 0 時半透明、點不下去。";

PAGES["diet/ditem"] = () => {
  const s = dstate;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(dietItemText(s?.items ?? null))}</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="dietStackOn" ${s?.itemShortcut ? "checked" : ""} />
        <span><b>迪城的水捷徑</b>${info(DIET_SHORTCUT_TIP)}
          <div class="hint">
            FRIENDLIST 正上方：精靈、古代、魔女，點一下就用（官方的 FRIENDLIST 與 ITEM 不動）
          </div>
        </span>
      </label>
    </div>`;
  return head("物品捷徑", "在迪城喝水不用開物品欄。") + state + toggle;
};

function gemUpText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (v.reason) return "有狀況：" + v.reason;
  if (!v.gemUp) return "關著";
  if (v.gemPct === null) return "生效中，但現在沒有 GEM 加成（沒有就不畫）";
  if (v.gemShown) return "生效中：迪城上顯示 +" + v.gemPct + "%";
  return "生效中，等你進迪城";
}
const GEM_UP_TIP =
  "跟大廳右側那張 GEM UP 同一張圖、同一種倒數（日:時:分:秒），圖上方多一行加成百分比（例如幸運的權杖Ⅰ是 +50%）。" +
  "資料是遊戲本來就有的加成清單，不送任何請求。";

PAGES["diet/gemup"] = () => {
  const s = dstate;
  const pct = s?.items?.gemPct ?? null;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(gemUpText(s?.items ?? null))}</span></div>
      <div class="row"><span class="dim">目前的 GEM 加成</span><span>${pct === null ? "沒有" : "+" + pct + "%"}</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="dietGemUpOn" ${s?.gemUp ? "checked" : ""} />
        <span><b>在迪城顯示 GEM UP</b>${info(GEM_UP_TIP)}
          <div class="hint">右側、跟大廳同一個位置：GEM UP 圖＋剩餘時間，上方標加成百分比。沒有 GEM 加成時不畫。</div>
        </span>
      </label>
    </div>`;
  return head("GEM UP", "在迪城刷 GEM 時看得到加成還剩多久。") + state + toggle;
};

function surrenderText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (v.reason) return "有狀況：" + v.reason;
  if (!v.dietNoConfirm && !v.outside && !v.dietWinSkip) return "照官方（渦的投降鈕在 MENU 裡）";
  if (v.outsideShown) return "生效中：投降鈕在 MENU 下方";
  return "生效中，等下一場對戰";
}
const SURRENDER_CONFIRM_TIP =
  "直接投降時按一下就送出，跟官方確認框按 ok 送的是同一個請求，插件不多送任何東西。" +
  "之後「你投降了」那個框不跳、結算畫面整個略過，直接進獎勵遊戲（沒有獎勵遊戲就回大廳）；" +
  "獎勵遊戲玩完後那顆 OK 照常自己按。" +
  "只在迪城的對戰；亞城照官方跳確認。渦的投降鈕本來就不確認、直接回渦房。";
const SURRENDER_WIN_TIP =
  "對手在迪城投降時，「對手投降了」那個框不跳、結算畫面整個略過，直接進獎勵遊戲" +
  "（沒有獎勵遊戲就回大廳）。插件不多送任何請求。" +
  "獎勵遊戲玩完後那顆 OK 照常自己按。亞城照官方。";
const SURRENDER_PLACE_TIP =
  "外面那顆跟 MENU 同一種鈕、貼在 MENU 正下方，MENU 裡就不再列投降。" +
  "迪城、亞城按下去走官方的投降流程（確認框也是官方的；迪城又選了直接投降就不問）；" +
  "渦是插件那顆，按下去直接回渦房。";

PAGES["diet/surrender"] = () => {
  const s = dstate;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(surrenderText(s?.surrender ?? null))}</span></div>
    </div>`;
  const opt = (group, current, value, label, hint) => `<label class="toggle">
      <input type="radio" name="${group}" value="${value}" ${current === value ? "checked" : ""} />
      <span><b>${label}</b><div class="hint">${hint}</div></span>
    </label>`;
  const confirm = s?.surrenderNoConfirm ? "direct" : "confirm";
  const place = s?.surrenderOutside ? "outside" : "menu";
  const win = s?.surrenderWinSkip ? "skip" : "notice";
  const confirmCard = `<div class="card">
      <div class="row"><span class="dim">迪城按投降時${info(SURRENDER_CONFIRM_TIP)}</span><span></span></div>
      ${opt("surrenderConfirm", confirm, "confirm", "跳出確認框", "照官方：問「你投降嗎?」，按 ok 才投降。")}
      ${opt("surrenderConfirm", confirm, "direct", "直接投降", "不跳確認框，按下去就投降，直接轉到獎勵遊戲。只在迪城。")}
    </div>`;
  const placeCard = `<div class="card">
      <div class="row"><span class="dim">投降鈕放在哪${info(SURRENDER_PLACE_TIP)}</span><span></span></div>
      ${opt("surrenderPlace", place, "menu", "收在 MENU 裡", "右上 MENU 打開才看得到（渦的那顆也在 MENU 裡）。")}
      ${opt("surrenderPlace", place, "outside", "放在外面", "MENU 正下方多一顆投降鈕。渦、迪城、亞城都算。")}
    </div>`;
  const winCard = `<div class="card">
      <div class="row"><span class="dim">迪城對手投降時${info(SURRENDER_WIN_TIP)}</span><span></span></div>
      ${opt("surrenderWin", win, "notice", "跳出通知框", "照官方：「對手投降了」，按 ok 才結算。")}
      ${opt("surrenderWin", win, "skip", "直接到獎勵", "不跳框、略過結算，直接轉到獎勵遊戲。只在迪城。")}
    </div>`;
  return head("投降", "投降少按幾下。") + state + confirmCard + winCard + placeCard;
};
