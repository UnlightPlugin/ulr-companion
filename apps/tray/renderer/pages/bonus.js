// 獎勵 › 物品捷徑／High Low／自動爬星。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 獎勵 › 物品捷徑 ---------------------------------------------------
//
// 住在物品欄那支注入腳本裡，狀態不在 snapshot 裡，開著才輪詢。
let bstate = null;
let bonusTimer = null;
const onBonusPage = () =>
  tab === "bonus" && (sub === "bitem" || sub === "bhighlow" || sub === "bclimb");

function startBonusPolling() {
  if (bonusTimer !== null) return;
  const tick = () =>
    window.ulr.bonus.state().then((s) => {
      bstate = s;
      if (!onBonusPage()) return;
      if (isEditing()) {
        scheduleCatchUp();
        return;
      }
      renderBody();
    });
  void tick();
  bonusTimer = setInterval(tick, 3000);
}
function stopBonusPolling() {
  if (bonusTimer !== null) clearInterval(bonusTimer);
  bonusTimer = null;
}

const BONUS_ITEM_NAMES = {
  4: "幸運四葉草",
  5: "白色石楠1",
  6: "白色石楠3",
  7: "白色石楠5",
  8: "跳越星",
};
function bonusItemText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (v.reason) return "沒作用：" + v.reason;
  if (!v.bonusItem) return "關著";
  if (v.inBonus)
    return "生效中：建議用 " + (BONUS_ITEM_NAMES[v.bonusPick] ?? "道具 " + v.bonusPick);
  return "生效中，等獎勵遊戲猜錯時出現";
}
const BONUS_ITEM_TIP =
  "能不能用照官方物品欄的判斷：兩顆骰子的差距不超過道具的數字（石楠1／3／5），四葉草（重投）與跳越星永遠能用。" +
  "差距小時先用剛好夠的那朵：差 1 用石楠1、差 2～3 用石楠3，沒有就往下找。" +
  "按下去走的是官方物品欄選了道具之後同一條路（同一個請求），插件不多送任何東西；官方這裡本來就沒有確認框，所以點一下就用掉。";

PAGES["bonus/bitem"] = () => {
  const s = bstate;
  const order = s?.order ?? snap?.profile?.bonusItemOrder ?? "heather5";
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(bonusItemText(s?.items ?? null))}</span></div>
    </div>`;
  const mode = !s?.itemShortcut ? "off" : (s?.place ?? "above");
  const opt = (group, current, value, label, hint) => `<label class="toggle">
      <input type="radio" name="${group}" value="${value}" ${current === value ? "checked" : ""} />
      <span><b>${label}</b><div class="hint">${hint}</div></span>
    </label>`;
  const modeOpt = (value, label, hint) => opt("bonusItemMode", mode, value, label, hint);
  const toggle = `<div class="card">
      <div class="row"><span class="dim">猜錯時建議一顆道具，點一下就用${info(BONUS_ITEM_TIP)}</span><span></span></div>
      ${modeOpt("off", "無捷徑", "照官方，按「使用物品」開物品欄自己挑。")}
      ${modeOpt("above", "使用物品左上", "多一顆圓鈕，跟四顆大鈕圍成一圈。「使用物品」照常能開物品欄。")}
      ${modeOpt("cover", "蓋住使用物品", "道具直接畫進「使用物品」裡，按同一個地方就用。沒有能用的道具時照官方；要自己挑別的請選左上。")}
      <div class="hint">例：5 猜大出 2 → 石楠3；7 猜小出 8 → 石楠1。</div>
    </div>`;
  const orderOpt = (value, label, hint) => opt("bonusItemOrder", order, value, label, hint);
  const picker = `<div class="card">
      <div class="row"><span class="dim">差距大於 3 時先用</span><span></span></div>
      ${orderOpt("heather5", "白色石楠5", "石楠5 → 四葉草 → 跳越星。差距超過 5 時石楠5 用不了，直接往下。")}
      ${orderOpt("clover", "幸運四葉草", "四葉草 → 石楠5 → 跳越星。四葉草是重投，重投後還是可能猜錯。")}
      ${orderOpt("star", "跳越星", "跳越星 → 石楠5 → 四葉草。")}
    </div>`;
  return head("物品捷徑", "獎勵遊戲猜錯時，不用開物品欄就能接關。") + state + toggle + picker;
};

function bonusHighLowText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (v.reason) return "沒作用：" + v.reason;
  if (!v.bonusHighLow) return "關著";
  if (v.highLowShown) return "生效中：High／Low 畫在獎勵遊戲上";
  return "生效中，等獎勵遊戲出現「下一個卡片」時畫上";
}
const BONUS_HIGHLOW_TIP =
  "按 High／Low 時插件替你先按「下一個卡片」再按你選的那顆，送的請求跟手動按兩下一模一樣，不多送任何東西。" +
  "猜對之後官方的大數字會停在上一回的底數，要按了下一個卡片才換；開著時直接換成這一回真正的底數。" +
  "伺服器回的底數萬一跟畫面上不一樣，就停在官方的 High／Low 畫面讓你重選，不會替你亂猜。";

PAGES["bonus/bhighlow"] = () => {
  const s = bstate;
  const on = s?.highLow ?? snap?.profile?.bonusHighLow ?? false;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(bonusHighLowText(s?.items ?? null))}</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="bonusHighLowOn" ${on ? "checked" : ""} />
        <span><b>High／Low 一起顯示</b>${info(BONUS_HIGHLOW_TIP)}
          <div class="hint">「下一個卡片」「得到卡片」出現時，上下兩格同時有 High、Low，直接按就猜。不想繼續照樣按得到卡片。</div>
        </span>
      </label>
    </div>`;
  const fastOn = s?.fast ?? snap?.profile?.bonusFast ?? false;
  const fast = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="bonusFastOn" ${fastOn ? "checked" : ""} />
        <span><b>跳過擲骰動畫</b>${info(BONUS_FAST_TIP)}
          <div class="hint">猜完骰子直接停在結果，淡出淡入、成功字樣、卡片滑動都快轉。按官方的 High／Low 也算。</div>
        </span>
      </label>
    </div>`;
  const rescueOn = s?.rescueFast ?? snap?.profile?.bonusRescueFast ?? false;
  const rescue = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="bonusRescueFastOn" ${rescueOn ? "checked" : ""} />
        <span><b>用道具後快轉</b>${info(BONUS_RESCUE_FAST_TIP)}
          <div class="hint">猜錯後用石楠、四葉草、跳越星救起來，接著的成功字樣、卡片滑動、重拿底數都快轉。</div>
        </span>
      </label>
    </div>`;
  const skipEndOn = s?.skipEnd ?? snap?.profile?.bonusSkipEnd ?? false;
  const skipEnd = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="bonusSkipEndOn" ${skipEndOn ? "checked" : ""} />
        <span><b>結束後直接回去</b>${info(BONUS_SKIP_END_TIP)}
          <div class="hint">按「得到卡片」或「結束遊戲」之後不看第二次結算、不用按 OK，直接回迪城（任務、渦也是回原本的房間）。升級時照樣播升級動畫。</div>
        </span>
      </label>
    </div>`;
  return (
    head("High Low", "獎勵遊戲不用先按「下一個卡片」，動畫也可以跳過。") +
    state +
    toggle +
    fast +
    rescue +
    skipEnd
  );
};
// --- 獎勵 › 自動爬星 ---------------------------------------------------
const CLIMB_KIND = {
  raid2: "渦二",
  chara1: "第一位角色卡",
  chara2: "第二位角色卡",
  chara3: "第三位角色卡",
  gem: "GEM",
  heather3: "白色石楠3",
  exp: "EXP",
};
const CLIMB_STOP = {
  noTarget: "沒有目標可拿",
  floor100: "到 100 層了",
  noItem: "猜錯了，沒有能用的道具",
  notWorth: "猜錯了，救起來不划算",
  quitNotWorth: "猜錯了，救起來不划算，已結束遊戲",
  quitNoItem: "猜錯了，沒有能用的道具，已結束遊戲",
  itemRefused: "道具用不了",
  noData: "讀不到獎品資料",
  error: "出錯了",
};
function bonusClimbText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  const c = v.climb;
  if (!c || !c.on) return "關著";
  if (!c.inBonus) return "生效中，等獎勵遊戲開始";
  const where = `${c.group === "lose" ? "敗場" : "勝場"}，第 ${c.step} 層（${c.start} 層起）`;
  if (c.stopped) {
    const why = CLIMB_STOP[c.stopped] ?? c.stopped;
    if (c.stopped.startsWith("quit")) return `${where}：${why}`;
    return `${where}：已交還給你 —— ${why}${c.stopped === "error" && v.reason ? "：" + v.reason : ""}`;
  }
  if (c.what === "seekRaid2") return `${where}：往上找渦二（到第 ${c.cell} 層）`;
  if (c.what === "seekGem") return `${where}：渦二沒出現，往上找 GEM`;
  if (c.what === "floor100") return `${where}：爬到 100 層`;
  if (c.what === "peek") return `${where}：往上看前幾層有沒有目標（到第 ${c.cell} 層）`;
  if (CLIMB_KIND[c.what]) return `${where}：去拿第 ${c.cell} 層的${CLIMB_KIND[c.what]}`;
  return where;
}
const BONUS_CLIMB_TIP =
  "替你按的是官方同一組按鈕（下一個卡片、High／Low、使用物品、得到卡片），送的請求跟手動按一模一樣，不多送任何東西。" +
  "畫面上只看得到腳下和後面三張，所以是邊爬邊看。" +
  "同時看到好幾種勾選的目標時：渦二 → 角色卡／GEM／白色石楠3（這三種誰近拿誰）→ EXP；腳下那張就是目標就收下。" +
  "看得到好幾張 GEM 時挑期望值最高的那張（遠一點但倍率高的，扣掉爬過去的花費還比較多就追它）。" +
  "沒有目標可拿時會停下來交還給你，不會替你收下用不到的卡；停下來之後這一場就不再動。";
const BONUS_CLIMB_CP_TIP =
  "猜錯時先算救起來划不划算，全部換成 GEM（跟 Moon 腳本同一套）：石楠1 200、石楠3 540、石楠5／四葉草／跳越星 900。" +
  "渦二、往上找渦二、爬 100 層：一定要到，有能用的道具就用。" +
  "勾了渦二時的 GEM（前幾層的、過了止損點改拿的）：也是有能用的就用 —— 摔了這一場就結束，前面爬的全白付。" +
  "角色卡（你填的價值 × 張數）：什麼道具都能用，但要比「價值 − 還剩幾層 × 90」便宜（90 是實際紀錄裡每爬一層平均花掉的 GEM）。" +
  "沒勾渦二時的 GEM（結算的 GEM 基數 × 卡上的倍率 × 加成）、白色石楠3（540）、EXP（結算的 EXP 基數 × 卡上的倍率 × 0.1，通常只有幾十）：只准用石楠1，而且「價值 × 0.687 的層數次方」要比 200 多 —— 所以 EXP 猜錯了不會救。" +
  "往上看前幾層這種沒有特定目標的：不救。" +
  "道具的順序：夠用的石楠1／石楠3 先，再來石楠5 → 跳越星 → 四葉草；下一層就是目標、而且骰壞的是 2／3／11／12 時先用四葉草（重猜幾乎必中）。";

function bonusClimbConfig() {
  return bstate?.climb ?? snap?.profile?.bonusClimb ?? null;
}
function applyBonusClimb(t) {
  const cur = bonusClimbConfig();
  if (cur === null) return;
  const next = { ...cur, win: { ...cur.win }, lose: { ...cur.lose } };
  const path = t.dataset.climb;
  const value = t.type === "checkbox" ? t.checked : Number(t.value);
  if (!path.includes(".")) next[path] = value;
  else {
    const [group, key] = path.split(".");
    if (next[group] === undefined) return;
    next[group][key] = value;
  }
  return window.ulr.bonus.climb(next).then((s) => {
    bstate = s;
    renderBody();
  });
}

PAGES["bonus/bclimb"] = () => {
  const s = bstate;
  const cfg = bonusClimbConfig();
  if (cfg === null) return head("自動爬星") + `<div class="card dim">讀取中…</div>`;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(bonusClimbText(s?.items ?? null))}</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" data-climb="on" ${cfg.on ? "checked" : ""} />
        <span><b>自動爬星</b>${info(BONUS_CLIMB_TIP)}
          <div class="hint">進獎勵遊戲後照下面勾的目標自己爬：猜大小、猜錯用道具、走到目標就收下。沒有目標時停下來交還給你。</div>
        </span>
      </label>
    </div>`;
  const rescue = `<div class="card">
      <div class="row"><span class="dim">猜錯時先算救起來划不划算${info(BONUS_CLIMB_CP_TIP)}</span><span></span></div>
      <div class="row">
        <span>角色卡每張的價值</span>
        <span><input type="number" data-climb="charaValue" min="0" max="99999" step="100" style="width:6em" value="${cfg.charaValue}" /> GEM</span>
      </div>
      <label class="toggle" style="margin-top:8px">
        <input type="checkbox" data-climb="quit" ${cfg.quit ? "checked" : ""} />
        <span><b>不划算就直接結束遊戲</b>
          <div class="hint">救起來不划算、或沒有能用的道具時：勾了直接按「結束遊戲」，沒勾就停下來交還給你。</div>
        </span>
      </label>
    </div>`;
  const num = (path, value, min, max) =>
    `<input type="number" data-climb="${path}" min="${min}" max="${max}" step="1" style="width:4.2em" value="${value}" />`;
  const goal = (group, g, key, label, body, hint) => `<label class="toggle">
      <input type="checkbox" data-climb="${group}.${key}" ${g[key] ? "checked" : ""} />
      <span><b>${label}</b>${body ? `<span class="dim">　${body}</span>` : ""}
        ${hint ? `<div class="hint">${hint}</div>` : ""}
      </span>
    </label>`;
  const within = (group, g, key) =>
    `開局起前 ${num(`${group}.${key}Within`, g[`${key}Within`], 1, 50)} 層內出現就拿`;
  const card = (group, title, note) => {
    const g = cfg[group];
    return `<div class="card">
      <div class="row"><span><b>${title}</b></span><span class="dim">${note}</span></div>
      ${goal(group, g, "gem", "GEM", within(group, g, "gem"), "")}
      ${goal(group, g, "chara1", "第一位角色卡", within(group, g, "chara1"), "")}
      ${goal(group, g, "chara2", "第二位角色卡", within(group, g, "chara2"), "")}
      ${goal(group, g, "chara3", "第三位角色卡", within(group, g, "chara3"), "看現在這副牌組那個位置的角色。×1 而且 Lv1 的是野生卡，不算。")}
      ${group === "win" ? goal(group, g, "raid2", "渦二", `止損點第 ${num(`${group}.raid2Max`, g.raid2Max, 1, 500)} 層`, "看得到就拿；沒看到就一路往上找到止損點，還沒有就改拿 GEM（繼續往上爬到看見為止，路上冒出渦二照樣拿）。渦一不拿 —— 要收圖鑑的話勾 100 層自己拿。") : ""}
      ${goal(group, g, "floor100", "100 層", "", group === "win" ? "一路爬到 100 層就停下來交還給你，路上不拿獎勵。跟渦二一起勾時以渦二為準。" : "一路爬到 100 層就停下來交還給你，路上不拿獎勵。")}
      ${group === "lose" ? goal(group, g, "heather3", "白色石楠3", within(group, g, "heather3"), "") : ""}
      ${goal(group, g, "exp", "EXP", within(group, g, "exp"), "滿等就不用勾。排在其他目標後面，猜錯不會為它花道具。")}
    </div>`;
  };
  return (
    head("自動爬星", "獎勵遊戲照勾選的目標自己爬，勝場、敗場各設一組。") +
    state +
    toggle +
    rescue +
    card("win", "勝場", "75 層起") +
    card("lose", "敗場", "55 層起；平手、時間到也算這一組")
  );
};

const BONUS_SKIP_END_TIP =
  "第二次結算的 OK 由插件替你按，走的是官方按下 OK 之後同一條路；得到的卡片、GEM、EXP 都已經在按「得到卡片／結束遊戲」那一刻由伺服器算好，不會因為沒看結算而少拿。" +
  "不多送任何請求。";
const BONUS_RESCUE_FAST_TIP =
  "官方用完道具後成功字樣會停 1.5 秒、卡片再慢慢滑過去；開著時這段一口氣跑完，結果是伺服器給的，畫面上的東西跟看完動畫一模一樣。" +
  "從物品欄選的、或用插件的道具捷徑都算。不多送任何請求。";
const BONUS_FAST_TIP =
  "點數是伺服器決定的，官方的骰子在擲出去那一刻就已經算好會停在哪一面；插件只是把物理一口氣推到停，不播滾動的過程，結果跟看完動畫一模一樣。" +
  "不多送任何請求。";
