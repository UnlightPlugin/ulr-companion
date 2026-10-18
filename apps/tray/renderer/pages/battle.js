// 戰鬥 › 準備／秒數上限。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 戰鬥 › 準備 ------------------------------------------------------
/**
 * OK 鈕的顏色。**「官方原本」是預設值**（玩家指定）。
 *
 * 琥珀色跟系統匣圖示的「已接上、還沒配對」同一個值，不是隨手挑的。
 */
const TINTS = [
  { label: "官方原本", value: null },
  { label: "琥珀色", value: 0xffc247 },
];
const hex = (n) => "#" + n.toString(16).padStart(6, "0");

/**
 * 準備功能現在到底有沒有在管，以及**為什麼沒有**。
 *
 * ⚠ 「否」一個字是不夠的。這個功能有四種不生效的理由，而玩家能自己處理的
 * 只有其中兩種（自己關掉、對手沒開）；另外兩種（在打 NPC、還沒握手）
 * 講不清楚的話，他會以為插件壞了而去重裝。
 */
function readyWhy(st, on) {
  if (!on) return "否（我自己關掉了）";
  if (!st?.connected) return "否（還沒接上遊戲）";
  const npc = NPC_RULE_TEXT[st.rule];
  if (npc) return `否（正在打${npc}，對手是 NPC）`;
  if (st.link !== "paired") return "否（還沒握手到對手的插件）";
  if (!st.agreed.readyEnabled) return "否（對手把準備關掉了）";
  return "是（雙方都開，已握手）";
}

PAGES["battle/ready"] = () => {
  const st = snap?.status;
  const on = snap?.profile.prefs.readyEnabled;
  const tint = snap?.profile.readyTint ?? null;
  const live = on && st?.pvp && st?.link === "paired" && st?.agreed.readyEnabled;
  return (
    head("準備", "按下 OK 不立刻送出，等對手也按了才同時送出。") +
    `<div class="card">
       <label class="toggle">
         <input type="checkbox" id="ready" ${on ? "checked" : ""} />
         <span><b>啟用準備功能</b>
           <div class="hint">
             再按一次可以取消，對手一動也會解除。<br />
             ⚠ <b>只在跟真人對戰、而且兩邊都握手成功時生效。</b>
             打任務、打渦以及對手沒裝插件時完全不介入。
           </div>
         </span>
       </label>
     </div>
     <div class="card">
       <div class="row"><span><b>OK 鈕的顏色</b></span></div>
       <div class="presets" id="tints">${TINTS.map(
         (t) =>
           `<button data-tint="${t.value === null ? "" : t.value}" aria-pressed="${
             t.value === tint
           }">${esc(t.label)}</button>`,
       ).join("")}</div>
       <label class="toggle" style="margin-top:10px">
         <input type="color" id="tintPick" value="${hex(tint ?? 0xffc247)}" />
         <span><b>自訂顏色</b>
           <div class="hint">
             準備中（壓著 OK 沒送出）時把按鈕染成這個顏色。<br />
             ⚠ 選「官方原本」＝完全不改遊戲畫面，代價是少了「插件正在管這個階段」的視覺提示 ——
             那時要改看系統圖示（見下方）。
           </div>
         </span>
       </label>
     </div>
     <div class="card">
       <div class="row"><span class="dim">我這邊</span><span>${on ? "已開啟" : "已關閉"}</span></div>
       <div class="row"><span class="dim">實際生效</span>
         <span class="${live ? "good" : "warn"}">${esc(readyWhy(st, on))}</span></div>
       <div class="row"><span class="dim">剛剛送出</span><span>${esc(st?.lastSend ?? "—")}</span></div>
     </div>`
  );
};

// --- 戰鬥 › 秒數上限 --------------------------------------------------
PAGES["battle/seconds"] = () => {
  const st = snap?.status;
  const prefs = snap?.profile.prefs;
  const lim = snap?.limits ?? { minSeconds: 5, maxSeconds: 30 };
  // ⚠ 「配到對手」不等於「秒數會生效」—— 打任務／渦時對面是 NPC，
  // 這條規則整組不套用（2026-08-09）。兩件事混在同一個布林裡的話，
  // 玩家會在渦裡看到「共同值 15 秒」然後等一個永遠不會來的強制結束。
  const paired = st?.link === "paired" && st?.pvp === true;
  const npcRule = NPC_RULE_TEXT[st?.rule];
  return (
    head("秒數上限", "移動階段要多長。共同值取<b>雙方比較長的那個</b>。") +
    `<div class="card">
       <div class="row"><span><b>我希望的階段長度</b></span>
         <span class="big" id="secLabel">${prefs?.phaseSeconds ?? 30}</span></div>
       <input type="range" id="seconds" min="${lim.minSeconds}" max="${lim.maxSeconds}"
              step="1" value="${prefs?.phaseSeconds ?? 30}" />
       <div class="ticks"><span>${lim.minSeconds} 秒</span><span>${lim.maxSeconds} 秒（不縮短）</span></div>
       <div class="hint ${paired ? "" : "warn"}" id="agreed">${
         paired
           ? `共同值 ${st.agreed.phaseSeconds} 秒（取雙方較長的那個）` +
             (st.hazard ? `，防止壓秒出聖水生效中 → ${st.capSeconds} 秒` : "")
           : npcRule
             ? `正在打${npcRule} —— 對手是 NPC，秒數不縮短（這條只對真人對戰）`
             : "還沒握手到對手 —— 秒數不會縮短（單方面縮短只是自己更早承諾）"
       }</div>
     </div>
     <div class="card">
       <div class="row"><span><b>防止壓秒出聖水</b></span
         ><span class="good">握手後強制生效</span></div>
       <div class="hint">
         手牌有聖水／聖杯，而且場上有麻痺、降低移動或<b>剩一回合的自壞</b>時，
         這個階段再短 5 秒。<br />
         ⚠ <b>這條不需要雙方同意</b>，握手成功就一起套用 ——
         它對兩邊對稱（同一個局面各砍同樣的秒數），沒有人能靠關掉它拿到優勢。<br />
         ⚠ <b>砍完不會低於 8 秒</b>（9→8、10→8、13→8、20→15）——
         砍到 4~5 秒連把牌拖到場上都來不及，而時間到是把<b>當下的場面</b>
         送出去，不是空手。
       </div>
     </div>`
  );
};
