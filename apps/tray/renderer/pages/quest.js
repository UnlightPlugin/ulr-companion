// 任務 › 物品捷徑／寶箱標註／確認框。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 任務 › 物品捷徑 / 寶箱標註 --------------------------------------
//
// 狀態不在 snapshot 裡（兩支注入腳本各要一次 CDP 往返），開著才輪詢。
let qstate = null;
let questTimer = null;
const onQuestPage = () =>
  tab === "quest" && (sub === "qitem" || sub === "chest" || sub === "qpanel");

function startQuestPolling() {
  if (questTimer !== null) return;
  const tick = () =>
    window.ulr.quest.state().then((s) => {
      qstate = s;
      if (!onQuestPage()) return;
      if (isEditing()) {
        scheduleCatchUp();
        return;
      }
      renderBody();
    });
  void tick();
  questTimer = setInterval(tick, 3000);
}
function stopQuestPolling() {
  if (questTimer !== null) clearInterval(questTimer);
  questTimer = null;
}

function questItemText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (!v.found) return "已裝上，等遊戲載入物品欄";
  if (v.reason) return "沒作用：" + v.reason;
  if (!v.questStack && !v.questPasses) return "生效中（捷徑都關著）";
  return v.inQuest ? "生效中：任務房上 " + v.questButtons + " 顆捷徑" : "生效中，等你進任務房";
}
const QUEST_SHORTCUT_TIP =
  "按下去走的是官方物品欄「使用」同一條路（同一個請求、用完官方自己重讀任務清單），插件不多送任何東西。" +
  "官方會不會先跳確認框照原樣。" +
  "水與沙漏固定五格，數量是 0 時半透明、點不下去；通行證有才顯示。";

PAGES["quest/qitem"] = () => {
  const s = qstate;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(questItemText(s?.items ?? null))}</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="questStackShortcutOn" ${s?.stackShortcut ? "checked" : ""} />
        <span><b>水沙捷徑</b>${info(QUEST_SHORTCUT_TIP)}
          <div class="hint">
            FRIENDLIST 正上方：精靈、古代、魔女、時間沙漏、超時空沙漏，點一下就用（官方的 FRIENDLIST 與 ITEM 不動）
          </div>
        </span>
      </label>
    </div>
    <div class="card">
      <label class="toggle">
        <input type="checkbox" id="questPassShortcutOn" ${s?.passShortcut ? "checked" : ""} />
        <span><b>通行證捷徑</b>
          <div class="hint">
            牌組與人物中間：有的通行證，鈕上標名字（影1、月2、風1、天1、活1）
          </div>
        </span>
      </label>
    </div>`;
  const always = `<div class="card">
      <div class="hint" style="margin-top:0">
        <b>一直都有的</b><br />
        · 物品欄開著時，面板外面照樣點得到；再按一次物品鈕就關<br />
        · 物品欄開著時點地圖，「開始搜索」會疊在物品欄上面，右上的 X 按得到<br />
        · 任務房的物品欄：增益類（髮冠、耳環、權杖、妖精、戒指、日記本）不列 —— 要用請到大廳的物品欄
      </div>
    </div>`;
  return head("物品捷徑", "任務房常用的水、沙漏與通行證，一點就用。") + state + toggle + always;
};

function questTreasureText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (!v.enabled) return "關著";
  if (!v.found) return "已裝上，等遊戲載入卡面";
  if (v.reason) return "有狀況：" + v.reason;
  return v.onMap ? "生效中：這張地圖標了 " + v.marks + " 格" : "生效中，等你打開任務地圖";
}
const QUEST_TREASURE_TIP =
  "官方只畫寶箱的種類，內容要踩到才知道。" +
  "內容表來自原版 Unlight 公開的伺服器資料（TreasureDatas），跟目前客戶端用到的寶箱對過，只缺一種。" +
  "只讀遊戲本來就有的資料，不送任何請求。";
const QUEST_BONUS_TIP =
  "High Low 格有等級（Lv1～Lv8），開始的星數跟等級有關，但客戶端沒有這張表。" +
  "進獎勵遊戲時官方本來就會跟伺服器拿開始的星數，插件順手記下「幾級、幾星起」，不多送請求。" +
  "不管標註開不開都會記。";

PAGES["quest/chest"] = () => {
  const s = qstate;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(questTreasureText(s?.treasure ?? null))}</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="questTreasureOn" ${s?.treasureMarks ? "checked" : ""} />
        <span><b>任務地圖的寶箱標註</b>${info(QUEST_TREASURE_TIP)}
          <div class="hint">
            每一格右邊畫出寶箱實際是什麼（官方的卡面：角色卡、武器／事件卡、道具、Gem）：<br />
            · 看牌組 COST 決定內容的格子：照你目前牌組的 COST 畫那一種，卡片下面標 COST 區間（例如 C76+）<br />
            · Exp 格：畫會拿到的卡 —— 牌頭同角色、等級 -1 的 L 卡（R 當 L 算，L1／R1 給 L1）<br />
            · High Low 格：標等級（Lv4），學到開始星數的話下一行標 ★<br />
            · 走過的格子不畫
          </div>
        </span>
      </label>
    </div>`;
  const bonus = s?.bonus ?? {};
  const levels = Object.keys(bonus)
    .map(Number)
    .sort((a, b) => a - b);
  const rows = levels.length
    ? levels
        .map((lv) => {
          const b = bonus[lv];
          const range = b.min === b.max ? `${b.min}` : `${b.min}～${b.max}`;
          return `<div class="row"><span class="dim">Lv${lv}</span><span>★${esc(range)}（${b.n} 筆）</span></div>`;
        })
        .join("")
    : `<div class="hint" style="margin-top:0">還沒學到。打一次任務的 High Low 格就會記下開始星數。</div>`;
  const learned = `<div class="card">
      <div class="row"><span><b>High Low 開始星數</b>${info(QUEST_BONUS_TIP)}</span></div>
      ${rows}
    </div>`;
  return (
    head("寶箱標註", "任務地圖上每一格的寶箱是什麼，進去之前就知道。") + state + toggle + learned
  );
};

function questPanelText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (v.reason) return "有狀況：" + v.reason;
  if (v.reward === "show" && v.end === "show" && !v.skipResult) return "生效中（都照官方）";
  const n = (v.rewardPressed ?? 0) + (v.endPressed ?? 0);
  const r = v.resultSkips ?? 0;
  if (n === 0 && r === 0) return "生效中，等你打怪、踩寶箱或結束任務";
  return (
    "生效中：這次開遊戲" +
    [n > 0 ? "替你按了 " + n + " 次 OK" : "", r > 0 ? "跳過 " + r + " 次結算" : ""]
      .filter(Boolean)
      .join("、")
  );
}
const QUEST_PANEL_TIP =
  "OK 由插件替你按，走的是官方按下 OK 之後同一條路；這幾個框按 OK 都不送任何請求，只是把框關掉，" +
  "寶箱內容、任務獎勵在框跳出來之前就已經入帳，不會因為沒看而少拿。";
const QUEST_SKIP_RESULT_TIP =
  "結算畫面是戰鬥打完、伺服器送來勝負之後才出現的，Gem／Exp 那時已經算好入帳。" +
  "插件只是不跑勝負字樣與數字的動畫，直接走官方按下 OK 之後那條路（回地圖、重拿任務資料），不多送請求。";

PAGES["quest/qpanel"] = () => {
  const s = qstate;
  const reward = s?.rewardPanel ?? snap?.profile?.questRewardPanel ?? "show";
  const end = s?.endPanel ?? snap?.profile?.questEndPanel ?? "show";
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(questPanelText(s?.treasure ?? null))}</span></div>
    </div>`;
  const opt = (group, current, value, label, hint) => `<label class="toggle">
      <input type="radio" name="${group}" value="${value}" ${current === value ? "checked" : ""} />
      <span><b>${label}</b><div class="hint">${hint}</div></span>
    </label>`;
  const rewardOpt = (value, label, hint) => opt("questRewardPanel", reward, value, label, hint);
  const endOpt = (value, label, hint) => opt("questEndPanel", end, value, label, hint);
  const rewardCard = `<div class="card">
      <div class="row"><span class="dim">踩到寶箱的「獲得寶箱」${info(QUEST_PANEL_TIP)}</span><span></span></div>
      ${rewardOpt("show", "照官方", "自己按 OK。")}
      ${rewardOpt("auto", "自動按 OK", "照常跳出、卡片翻開，看一下（約 1.5 秒）就替你按 OK。")}
      ${rewardOpt("hide", "不顯示", "不跳框、沒有動畫，直接關掉、接著走。拿到什麼可以看寶箱標註或物品欄。")}
    </div>`;
  const endCard = `<div class="card">
      <div class="row"><span class="dim">任務結束的確認框${info(QUEST_PANEL_TIP)}</span><span></span></div>
      ${endOpt("show", "照官方", "自己按 OK。")}
      ${endOpt("auto", "自動按 OK", "任務成功／失敗、結束時拿到的新任務照常跳出，看一下（約 1.2 秒）就替你按 OK。")}
      ${endOpt("hide", "不顯示", "不跳框、沒有動畫，直接回任務清單。")}
      <div class="hint">搜尋任務找到的「發現新任務」照常顯示，只跳過任務結束時給的那個。劇情照常播。</div>
    </div>`;
  const skipOn = s?.skipResult ?? snap?.profile?.questSkipResult ?? false;
  const skipCard = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="questSkipResultOn" ${skipOn ? "checked" : ""} />
        <span><b>打完怪物跳過結算</b>${info(QUEST_SKIP_RESULT_TIP)}
          <div class="hint">不看 WIN／LOSE 與 Gem／Exp 結算，直接回任務地圖。升級時照樣播升級動畫；有獎勵遊戲的那場照官方。</div>
        </span>
      </label>
    </div>`;
  return (
    head("確認框", "打怪結算、寶箱與任務結束的確認框，自動按 OK 或乾脆不顯示。") +
    state +
    skipCard +
    rewardCard +
    endCard
  );
};
