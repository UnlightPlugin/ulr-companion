// 戰鬥 › 記牌／牌譜。
// 載入順序見 index.html 底部。
"use strict";

// --- 戰鬥 › 牌譜 -------------------------------------------------------
//
// 清單不在 snapshot 裡（要讀檔），開著這一頁才每 5 秒重讀一次（主程序那邊照檔案大小快取）。
let kifuItems = null;
let kifuTimer = null;
const onKifuPage = () => tab === "battle" && (sub === "replay" || sub === "stats");

function startKifuPolling() {
  if (kifuTimer !== null) return;
  const tick = () =>
    window.ulr.kifu.list().then((items) => {
      kifuItems = items;
      if (!onKifuPage()) return;
      if (isEditing()) {
        scheduleCatchUp();
        return;
      }
      renderBody();
    });
  void tick();
  kifuTimer = setInterval(tick, 5000);
}
function stopKifuPolling() {
  if (kifuTimer !== null) clearInterval(kifuTimer);
  kifuTimer = null;
}

const KIFU_RULES = { duel: "對戰", ranked: "排名戰", quest: "任務", raid: "渦", event: "活動" };
const KIFU_RESULTS = { win: "勝", lose: "敗", draw: "平" };

function kifuWhen(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

PAGES["battle/replay"] = () => {
  const on = snap?.profile.kifuRecord !== false;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="kifuRecordOn" ${on ? "checked" : ""} />
        <span><b>錄牌譜</b>
          <div class="hint">
            每一場（對戰、任務、渦、活動）收到的每一則戰鬥事件都存下來：抽牌、出牌、轉牌、翻牌、移動、
            攻防值、擲骰、傷害、技能、狀態與回合數、換角。<br />
            打完時順便存當時版本的資料表與美術，<b>改版之後照樣用當時的樣子重播</b>。
            只存這個客戶端畫面上看得到的東西（對手蓋著的牌伺服器本來就不送）。
          </div>
        </span>
      </label>
    </div>`;
  const items = kifuItems;
  let list;
  if (items === null)
    list = `<div class="card"><div class="hint" style="margin-top:0">讀取中…</div></div>`;
  else if (items.length === 0)
    list = `<div class="card"><div class="hint" style="margin-top:0">還沒有牌譜 —— 打一場就會出現在這裡。</div></div>`;
  else
    list = `<div class="card"><table class="kifu-list">
      <thead><tr><th>時間</th><th>模式</th><th>地點</th><th>對手</th><th>回合</th><th>結果</th><th></th></tr></thead>
      <tbody>${items
        .map(
          (k) => `<tr>
            <td>${esc(kifuWhen(k.startedAt))}</td>
            <td>${esc(KIFU_RULES[k.rule] ?? k.rule ?? "?")}</td>
            <td>${esc(k.stageName ?? k.stage ?? "?")}</td>
            <td>${esc(k.opponent ?? "—")}</td>
            <td>${k.turns ?? "—"}${k.partial ? `<span class="dim" title="中途才開始錄">＊</span>` : ""}</td>
            <td>${esc(KIFU_RESULTS[k.result] ?? (k.result ? k.result : "—"))}</td>
            <td><button data-kifuplay="${esc(k.file)}" ${k.snapshot ? "" : 'title="這場沒有版本快照，只能看文字"'}>播放</button>
              <button data-kifuingame="${esc(k.file)}" ${snap?.status?.connected ? "" : "disabled"}
                title="蓋在遊戲畫面上播（戰鬥中不開）">遊戲裡</button></td>
          </tr>`,
        )
        .join("")}</tbody></table></div>`;
  const where = `<div class="card"><div class="hint" style="margin-top:0">
      存在 <code>%USERPROFILE%\\.ulr-companion\\battle</code>。同一個版本的美術只存一份，之後每場只多幾百 KB。
    </div></div>`;
  return head("牌譜", "錄下每一場戰鬥，事後照當時的版本與美術重播。") + toggle + list + where;
};

// --- 戰鬥 › 戰績 -------------------------------------------------------
//
// 全部從牌譜清單算（kifu.list 每 5 秒重讀，跟牌譜頁同一份）。只算打完的（有結果的）。

function kifuTally(list) {
  const t = { win: 0, lose: 0, draw: 0 };
  for (const k of list) {
    if (k.result === "win") t.win++;
    else if (k.result === "lose") t.lose++;
    else if (k.result) t.draw++;
  }
  return t;
}
function kifuRate(t) {
  const n = t.win + t.lose + t.draw;
  return n === 0 ? "—" : `${Math.round((t.win / n) * 100)}%`;
}
function kifuGroupTable(title, items, keyOf, labelOf, limit) {
  const groups = new Map();
  for (const k of items) {
    const key = keyOf(k);
    if (key === null || key === undefined || key === "") continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(k);
  }
  const rows = [...groups.entries()]
    .map(([key, list]) => ({ key, list, t: kifuTally(list) }))
    .sort((a, b) => b.list.length - a.list.length)
    .slice(0, limit);
  if (rows.length === 0) return "";
  return `<div class="card"><b>${esc(title)}</b><table class="kifu-list">
    <thead><tr><th></th><th>場</th><th>勝</th><th>敗</th><th>平</th><th>勝率</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr><td>${esc(labelOf(r.key, r.list))}</td><td>${r.list.length}</td>
          <td>${r.t.win}</td><td>${r.t.lose}</td><td>${r.t.draw}</td><td>${kifuRate(r.t)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
}

PAGES["battle/stats"] = () => {
  const items = kifuItems;
  const intro = head("戰績", "從牌譜整理：勝率、地點、對手、牌組，還有骰子的實測。");
  if (items === null)
    return intro + `<div class="card"><div class="hint" style="margin-top:0">讀取中…</div></div>`;
  const done = items.filter((k) => k.result);
  if (done.length === 0)
    return (
      intro +
      `<div class="card"><div class="hint" style="margin-top:0">還沒有打完的牌譜 —— 「戰鬥 › 牌譜」的錄牌譜要開著。</div></div>`
    );
  const all = kifuTally(done);
  const summary = `<div class="card"><b>全部</b>：${done.length} 場　${all.win} 勝 ${all.lose} 敗 ${all.draw} 平　勝率 ${kifuRate(all)}</div>`;
  const byRule = kifuGroupTable(
    "模式",
    done,
    (k) => k.rule,
    (key) => KIFU_RULES[key] ?? key,
    10,
  );
  const byStage = kifuGroupTable(
    "地點",
    done,
    (k) => k.stage,
    (key, list) => list[0].stageName ?? key,
    20,
  );
  const duels = done.filter((k) => k.rule === "duel" || k.rule === "ranked");
  const byOpp = kifuGroupTable(
    "對手（對戰，前 30 名）",
    duels,
    (k) => k.opponent,
    (key) => key,
    30,
  );
  const byDeck = kifuGroupTable(
    "我的牌組（角色卡 id）",
    done,
    (k) => (k.myCharas && k.myCharas.length ? k.myCharas.join(" / ") : null),
    (key) => key,
    15,
  );
  // 骰子：記牌面板的骰率假設「一顆 1/3 成功、傷害＝攻擊成功數−防禦成功數」，這裡是實測
  const d = { n: 0, suc: 0, gold: 0, dmgOk: 0, dmgN: 0 };
  for (const k of items) {
    if (!k.dice) continue;
    for (const f of Object.keys(d)) d[f] += k.dice[f] ?? 0;
  }
  const dice = `<div class="card"><b>骰子實測</b>（記牌面板的骰率用「每顆 1/3 成功」）
    <div class="hint">擲了 ${d.n} 顆（不含金骰 ${d.gold} 顆），成功 ${d.suc} 顆
      ${d.n > 0 ? `＝ <b>${((d.suc / d.n) * 100).toFixed(1)}%</b>（1/3 ＝ 33.3%）` : ""}<br />
      「傷害＝攻擊成功數−防禦成功數」：${d.dmgN > 0 ? `${d.dmgOk}/${d.dmgN} 次對得上` : "還沒有樣本"}
      （技能、被動會改傷害，差一點是正常的）</div></div>`;
  return intro + summary + dice + byRule + byStage + byOpp + byDeck;
};

// --- 戰鬥 › 記牌 -------------------------------------------------------

PAGES["battle/count"] = () => {
  const on = snap?.profile.cardCounter !== false;
  return (
    head("記牌", "戰鬥中顯示公牌還剩哪些。") +
    `<div class="card">
       <label class="toggle">
         <input type="checkbox" id="cardCounterOn" ${on ? "checked" : ""} />
         <span><b>顯示記牌面板</b>
           <div class="hint">
             每個地點的公牌是固定的一疊。整疊扣掉<b>你看過的</b>（自己抽到的、雙方翻開的），
             剩下的就是還在牌堆裡或在對手手上蓋著的牌；洗牌時重算。每一種後面的百分比是下一張抽到它的機率。<br />
             攻防階段雙方數值出來後，下面多三行骰率：平均傷害、至少 1 點的機率、打得死的機率
             （每顆骰 1/3 成功；實測在「戰績」頁）。對戰時再多兩行：跟這個對手的戰績、他上次用的角色。<br />
             只用畫面上看得到的東西 —— 對手蓋著的牌插件也不知道是什麼。
             對戰、任務、渦都會顯示。
           </div>
         </span>
       </label>
     </div>`
  );
};
