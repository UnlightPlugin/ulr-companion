// 渦 › 獎勵標記／結算通知／物品捷徑／發現渦／渦通報。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 渦 › 獎勵標記 / 結算通知 ----------------------------------------
//
// 狀態不在 snapshot 裡（兩支注入腳本各要一次 CDP 往返），開著才輪詢。
let rstate = null;
let raidTimer = null;
const onRaidPage = () =>
  tab === "vortex" &&
  (sub === "vrank" || sub === "vreward" || sub === "vitem" || sub === "vfound" || sub === "vfeed");

function startRaidPolling() {
  if (raidTimer !== null) return;
  const tick = () =>
    window.ulr.raid.state().then((s) => {
      rstate = s;
      if (!onRaidPage()) return;
      if (isEditing()) {
        scheduleCatchUp();
        return;
      }
      renderBody();
    });
  void tick();
  raidTimer = setInterval(tick, 3000);
}
function stopRaidPolling() {
  if (raidTimer !== null) clearInterval(raidTimer);
  raidTimer = null;
}
function applyRaidRewardMode(mode) {
  return window.ulr.raid.rewardMode(mode).then((s) => {
    rstate = s;
    renderBody();
  });
}

function raidViewText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (!v.inRaid) return "已裝上，等你進渦房";
  return "生效中：" + v.rows + " 列清單、" + v.vortices + " 顆地圖渦";
}

const RAID_MARK_TIP =
  "2026-09-23 改版後渦清單不再給 TL。碎片色（黃＝記憶、綠＝時間、藍＝靈魂、紅＝生命、紫＝死亡；圓的是渦幣）" +
  "看渦的 stage 套公式：你打過的渦用那場戰鬥的 stage、自己發現的渦用發現時的 stage，其次是 ulgg 觀測站給的；" +
  "都沒有就看插件自己學到的：" +
  "每收到一次渦的結算，把那個渦實際發的東西依「怪物＋渦階＋★＋地圖區塊」記下來（本機 raid-learned.json），" +
  "同一種渦之後直接畫；兩次對不上就不拿來畫。都沒有的渦不畫任何標記 —— 不猜。";
const RAID_SHARE_TIP =
  "開著的話，你渦清單上的渦（TL、BOSS 狀態、HP）會傳到 Cloudflare Workers（插件作者架的），別人在 SUPPORT 看到同一個渦就查得到；" +
  "你也查得到別人傳的。上面只存渦碼的雜湊，不存渦碼本身、不存分數榜與玩家名字 —— 不知道渦碼的人查不到。" +
  "ulgg 是主要來源，這個是它掛掉或還沒掃到時的備援；同一個渦取比較新的那份。";
const RAID_TEAM_TIP =
  "每打完一場渦，插件記下用的那副牌、選的回合、花的 AP、戰鬥中打掉的傷害，回到渦房後看排行榜上自己的分數漲了多少。" +
  "開著的話這些會傳到 Cloudflare Workers（插件作者架的），同一個渦裡開插件的人在渦的詳細畫面點排行榜上你的名字就看得到；你也看得到別人的。" +
  "上面的渦（發現者＋發現時刻）與名字都只存雜湊（名字是跟渦一起算的），不在那個渦裡的人查不到，也串不起你打過哪些渦。" +
  "關掉後下一輪會把 Cloudflare Workers 上你的隊伍撤掉；自己的隊伍在自己的畫面上照樣看得到。";
const RAID_PUBLIC_TIP =
  "SUPPORT 那份公開渦清單伺服器不給 TL，圖示是靠 ulgg.online 的觀測站對渦碼查來的，" +
  "只在你人在渦房時每 30 秒問一次；ulgg 掛了就只是沒圖示，其他功能照常。";

PAGES["vortex/vrank"] = () => {
  const s = rstate;
  const v = s?.view ?? null;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(raidViewText(v))}</span></div>
      <div class="row"><span class="dim">公開渦表${info(RAID_PUBLIC_TIP)}</span><span>${v?.publicCount ?? 0} 筆</span></div>
      ${v?.reason && v.installed ? `<div class="hint warn">⚠ ${esc(v.reason)}</div>` : ""}
    </div>`;
  const what = `<div class="card">
      <div class="hint" style="margin-top:0">
        <b>渦房裡會多出來的東西</b>${info(RAID_MARK_TIP)}<br />
        · 清單：名字右邊接碎片色，排名獎勵有魔之素材／書籤的再接那張圖<br />
        · 地圖：渦照碎片色上色，還不知道的是灰色；素材渦上方掛圖，自己開的渦紅框<br />
        · 點進渦之後多一顆「獎勵一覽」：發現／參加／每一檔排名／擊破，自己現在那一檔亮一點<br />
        · Profound 計數下面的「Refresh」：等於重進渦房（渦清單、AP、死渦的結算一起重讀），順便馬上重查 Cloudflare Workers<br />
        · 它左邊的「History」（上面可以關）：以前拿過的渦獎勵。前三頁是今天／7 天／全部的合計，後面一頁 4 個渦、新的在前；紀錄只存在這台電腦，留最近 2000 個渦<br />
        · 詳細畫面的排行榜：有隊伍紀錄的名字後面多一顆牌組圖示，點名字看那個人打這個渦用的隊伍<br />
        · SUPPORT 清單：已經通報過、碎片知道了的渦，名字右邊接碎片色（見「渦通報」）
      </div>
      <div class="hint">
        改版後客戶端不再給每個人的傷害，傷害統計先停用（打渦隊伍的傷害改成插件在戰鬥中自己算）。
      </div>
    </div>`;
  const histCard = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="raidHistoryButtonOn" ${s?.historyButton !== false ? "checked" : ""} />
        <span><b>顯示「History」鈕</b>
          <div class="hint">
            渦房 Refresh 左邊那顆，按下去看以前拿過的渦獎勵。關掉只是不畫這顆鈕，獎勵照樣記錄，之後打開還看得到。
          </div>
        </span>
      </label>
    </div>`;
  const share = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="raidShareOn" ${s?.share !== false ? "checked" : ""} />
        <span><b>和其他插件玩家互傳渦狀態</b>${info(RAID_SHARE_TIP)}
          <div class="hint">
            ulgg 掛了或還沒掃到的公開渦，靠其他開插件的玩家補上。Discord 的公開渦通報也靠這個（見「渦通報」）。
          </div>
        </span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="raidTeamShareOn" ${s?.teamShare !== false ? "checked" : ""} ${s?.share === false ? "disabled" : ""} />
        <span><b>分享打渦用的隊伍</b>${info(RAID_TEAM_TIP)}
          <div class="hint">
            別人點你的名字看得到你用哪副牌、打了幾場、幾回合、幾 AP、多少傷害 —— 給不知道該帶什麼、該花多少 AP 的新手參考。
            ${s?.share === false ? "（要先打開上面的互傳）" : ""}
          </div>
        </span>
      </label>
    </div>`;
  return head("獎勵標記", "渦打倒後發什麼，直接畫在渦房裡。") + state + share + histCard + what;
};

function raidRewardText(r) {
  if (r === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!r.installed) return "還沒裝上" + (r.reason ? "：" + r.reason : "");
  // 腳本跑了但掛不上（客戶端改版把方法改名）——不能說生效中
  if (r.reason) return "沒作用：" + r.reason;
  return r.open ? "摘要面板開著" : "生效中";
}
const AUTO_DELETE_TIP =
  "刪渦走的是官方「放棄」同一個動作。死渦在結算發下來之前刪掉會不會吃掉獎勵沒人驗過，所以有你一份的會等結算收到才刪。" +
  "死渦的詳細面板上也有開關；在遊戲裡關掉之後，要再開只能在這裡。";
const REWARD_TIP =
  "你參加過的渦被打倒後，官方會一頁一頁演結算，每一件獎勵都要按一次 OK。" +
  "獎勵在伺服器推過來那一刻就已經入帳，面板純粹是演出 —— 不演不會少拿。" +
  "「只通知一次」會畫一張摘要列出這一批所有渦與獎勵、一顆 OK；面板上有開關可以要求之後照樣顯示官方畫面。" +
  "不管哪個模式，記錄頁都會記一行拿了什麼。";

PAGES["vortex/vreward"] = () => {
  const s = rstate;
  const mode = s?.rewardMode ?? snap?.profile?.raidRewardMode ?? "once";
  const opt = (value, label, hint) => `<label class="toggle">
      <input type="radio" name="raidRewardMode" value="${value}" ${mode === value ? "checked" : ""} />
      <span><b>${label}</b><div class="hint">${hint}</div></span>
    </label>`;
  const picker = `<div class="card">
      ${opt("all", "全部通知", "官方原樣：每個渦、每件獎勵都要按一次 OK。")}
      ${opt("once", "只通知一次", "一張官方樣式的面板列出這一批所有渦與每一樣獎勵（卡面），一顆 OK。")}
      ${opt("none", "不再通知", "什麼都不跳。拿了什麼看「設置 › 記錄」。")}
    </div>`;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態${info(REWARD_TIP)}</span><span>${esc(raidRewardText(s?.reward ?? null))}</span></div>
    </div>`;
  const autoDel = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="raidAutoDeleteOn" ${s?.autoDelete ? "checked" : ""} />
        <span><b>自動刪除 HP 歸零的渦</b>${info(AUTO_DELETE_TIP)}
          <div class="hint">
            沒有你一份獎勵的死渦馬上刪；有你一份的，等那個渦的結算收到了才刪。
            ${s && !s.autoDelete && !s.autoDeletePrompt ? "（你在遊戲裡關掉過，遊戲內的開關鈕已收起；在這裡打開會一起恢復）" : ""}
          </div>
        </span>
      </label>
    </div>`;
  return head("結算通知", "渦被打倒之後的 OK 面板要怎麼演。") + picker + state + autoDel;
};

function itemPanelText(v) {
  if (v === null) return "還沒接上遊戲 —— 開了遊戲就會自己裝上";
  if (!v.installed) return "還沒裝上" + (v.reason ? "：" + v.reason : "");
  if (!v.found) return "已裝上，等遊戲載入物品欄";
  if (v.reason) return "沒作用：" + v.reason;
  if (!v.shortcut) return "生效中（捷徑關著）";
  return v.inRaid ? "生效中：渦房上 " + v.buttons + " 顆捷徑" : "生效中，等你進渦房";
}
const ITEM_SHORTCUT_TIP =
  "按下去走的是官方物品欄「使用」同一條路（同一個請求、用完官方自己重讀渦清單），插件不多送任何東西。" +
  "官方對水和渦探知機本來就不跳確認框，所以點一下就用掉；增益類才會問。" +
  "水的數量是 0 時半透明、點不下去；探知機沒有就不顯示。";

PAGES["vortex/vitem"] = () => {
  const s = rstate;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(itemPanelText(s?.items ?? null))}</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="raidItemShortcutOn" ${s?.itemShortcut ? "checked" : ""} />
        <span><b>渦房的物品捷徑</b>${info(ITEM_SHORTCUT_TIP)}
          <div class="hint">
            藏起右下角的 FRIENDLIST 與 ITEM，改放捷徑，點一下就用：<br />
            · 右下：古代（原 FRIENDLIST）、精靈（原 ITEM）；SUPPORT 不動<br />
            · 「輸入Raid代碼」上方：渦探知機（渦一、渦二在前），有才顯示
          </div>
        </span>
      </label>
    </div>`;
  const always = `<div class="card">
      <div class="hint" style="margin-top:0">
        <b>一直都有的</b><br />
        · 物品欄開著時，面板外面照樣點得到；再按一次物品鈕就關<br />
        · 渦房的物品欄：回 AP 的水排最前，接著渦二、渦一；增益類（髮冠、耳環、權杖、妖精、戒指、日記本）不列 —— 要用請到大廳的物品欄
      </div>
    </div>`;
  return head("物品捷徑", "渦房常用的水與渦探知機，一點就用。") + state + toggle + always;
};

// --- 渦 › 發現渦 -------------------------------------------------------
//
// 用渦探知機發現渦之後（patch-raid-view ⑭）。跳過開場一個開關；公開與否照「BOSS × 碎片」
// 一格一格挑（玩家 2026-10-17：「公開藍龜，黃龜刪除」）。預設全部「不動」。
// 列（BOSS）與欄（碎片）都從 main 拿（RAID_DISCOVER_BOSSES／RAID_FRAGMENTS），不在這裡抄一份。
const RAID_DISCOVER_TIP =
  "公開／好友走的是官方渦碼視窗同一條路：參加資格不對才改（同一個請求），再按「送出」。" +
  "刪除走官方「放棄」。碎片看的是發現時伺服器給的 stage，跟渦房清單上的碎片色同一套公式；" +
  "判不出來（沒收到發現畫面）就不動。插件沒接著遊戲時發現的渦不會補做。";
const DISCOVER_ACTS = [
  ["keep", "—"],
  ["public", "公開"],
  ["friends", "好友"],
  ["discord", "渦碼"],
  ["delete", "刪除"],
];
const DISCOVER_TIERS = [
  ["I", "渦一（幣，顏色同碎片）"],
  ["II/III", "渦二·三"],
  ["IV", "渦四"],
  ["?", "碎片發現時看不出來"],
];

/** 一格（或整組）的下拉。cur 是 null＝整組裡不一樣，顯示「整組…」。 */
const discoverSelect = (keys, cur, label) =>
  `<select class="dact a-${cur ?? "mixed"}" data-dkeys="${esc(keys.join(","))}" aria-label="${esc(label)}">${
    cur === null ? `<option value="" selected>整組…</option>` : ""
  }${DISCOVER_ACTS.map(
    ([v, t]) => `<option value="${v}"${cur === v ? " selected" : ""}>${t}</option>`,
  ).join("")}</select>`;

PAGES["vortex/vfound"] = () => {
  const s = rstate;
  const rules = s?.discoverRules ?? {};
  const frags = s?.discoverFragments ?? [];
  const bosses = s?.discoverBosses ?? [];
  const keysOf = (b) => (b.byFragment ? frags.map((f) => `${b.mons}:${f.key}`) : [`${b.mons}:any`]);
  const actOf = (k) => rules[k] ?? "keep";
  const same = (keys) => {
    const a = keys.map(actOf);
    return a.every((x) => x === a[0]) ? a[0] : null;
  };
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="raidDiscoverSkipOn" ${s?.discoverSkipOpening ? "checked" : ""} />
        <span><b>跳過開場動畫</b>
          <div class="hint">發現渦時不播開場（每一種渦都一樣），跟下面的規則無關。</div>
        </span>
      </label>
    </div>`;
  const head5 = frags
    .map(
      (f) => `<th><span class="dot" style="background:${esc(f.css)}"></span>${esc(f.short)}</th>`,
    )
    .join("");
  let body = "";
  for (const [tier, tierName] of DISCOVER_TIERS) {
    const group = bosses.filter((b) => b.tier === tier);
    if (group.length === 0) continue;
    const all = group.flatMap(keysOf);
    body += `<tr class="tier"><td>${esc(tierName)}</td><td colspan="${frags.length}">${discoverSelect(
      all,
      same(all),
      `${tierName}整組`,
    )}</td></tr>`;
    for (const b of group) {
      const keys = keysOf(b);
      const cells = b.byFragment
        ? keys
            .map(
              (k, i) =>
                `<td>${discoverSelect([k], actOf(k), `${b.name} ${frags[i]?.short ?? ""}`)}</td>`,
            )
            .join("")
        : `<td colspan="${frags.length}">${discoverSelect(keys, actOf(keys[0]), b.name)}
             <span class="dim">碎片隨機／看不出來，一格管全部</span></td>`;
      body += `<tr><td class="boss">${esc(b.name)}</td>${cells}</tr>`;
    }
  }
  const rulesOn = s?.discoverRulesOn === true;
  const grid = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="raidDiscoverRulesOn" ${rulesOn ? "checked" : ""} />
        <span><b>發現後做什麼</b>${info(RAID_DISCOVER_TIP)}
          <div class="hint">
            ${
              rulesOn
                ? "開著：發現渦時照下面的表做。"
                : "<b>暫停中</b>：發現渦什麼都不做，下面的表留著，打開就照舊。"
            }
          </div>
        </span>
      </label>
      <div class="hint">
        公開＝參加資格「無限制」並送出（會進 Discord 渦通報）；好友＝「僅限好友」並送出；
        渦碼＝參加資格「無限制」但不送出，渦碼由機器人發到 Discord，只有頻道裡的人能加入；
        刪除＝直接放棄；—＝不動。每一組第一列可以整組一起改。
      </div>
      <div class="hint">
        ⚠ 「渦碼」會把渦碼經 Cloudflare Workers 發到 Discord 頻道，看得到頻道的人都能用。
        要「渦 › 渦通報」開著才會發；發出去之前一樣先等 1 分鐘、渦還在才發。
      </div>
      <table class="dgrid${rulesOn ? "" : " paused"}">
        <thead><tr><th></th>${head5}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  return (
    head("發現渦", "用渦探知機發現渦之後：跳過開場，照 BOSS 與碎片公開、分享給好友或刪掉。") +
    toggle +
    grid
  );
};

// --- 渦 › 渦通報 -------------------------------------------------------
//
// 公開渦的 Discord 通知（docs/raid-feed.md）。沒有自己的開關：上傳跟著「獎勵標記」的
// 互傳開關走（engine 的 #raidShare），這裡放同一顆 checkbox、同一個 id。
const RAID_FEED_TIP =
  "插件只在你本來就會做的操作裡順手抓：打開 SUPPORT 時那份公開清單、進渦房／Refresh 時自己的渦清單、開打那一刻看到的 stage 與 BOSS 狀態。" +
  "收到的渦由 Cloudflare Workers（插件作者架的）彙整，新渦湊 30 秒發一則到 Discord，之後有變化就編輯同一則。" +
  "渦碼在遊戲頁面裡就丟掉，不上傳 —— 只有你在「發現渦」規則表挑了「渦碼」的自己的渦例外；" +
  "發現者名字會上傳，因為 Discord 訊息本來就公開它。";

PAGES["vortex/vfeed"] = () => {
  const s = rstate;
  const on = s?.share !== false;
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${
        on ? "開著，在渦房時順手回報" : "關著，不回報"
      }</span></div>
    </div>`;
  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="raidShareOn" ${on ? "checked" : ""} />
        <span><b>回報公開渦給 Discord 機器人</b>${info(RAID_FEED_TIP)}
          <div class="hint">
            你看到的公開渦，由機器人發到 Discord 的渦碼分享區。<br />
            跟「獎勵標記」的「和其他插件玩家互傳渦狀態」是同一個開關。
          </div>
        </span>
      </label>
    </div>`;
  const what = `<div class="card">
      <div class="hint" style="margin-top:0">
        <b>會發哪些渦</b><br />
        · SUPPORT 公開清單上的渦（有人打開 SUPPORT 時抓到）<br />
        · 自己開的渦，參加資格選「無限制」按送出後等 1 分鐘、渦還在才發（送出後馬上刪掉的不發）<br />
        · 「發現渦」規則挑了「渦碼」的自己的渦：附上渦碼（不進 SUPPORT，只有頻道裡的人拿得到）<br />
        · 渦 I～IV 都發<br />
        · 不發：僅限好友、只靠渦碼加入的渦；已經打倒的
      </div>
      <div class="hint">
        <b>回到遊戲裡</b><br />
        · 通報過、碎片知道了的渦，SUPPORT 清單上名字右邊接碎片色 —— 還沒加入就知道掉什麼<br />
        · 剛冒出來、還沒有開插件的人加入或開打的渦，碎片還不知道，不畫
      </div>
      <div class="hint">
        <b>一則訊息</b><br />
        · 一行一個渦：發現者、碎片色＋BOSS、HP；渦 IV 會 @渦4<br />
        · 之後自己改：碎片從 ❓ 換成顏色、HP 跟上、打倒變 ☠️、到期沒打倒標 ⌛
      </div>
    </div>`;
  const why = `<div class="card">
      <div class="hint" style="margin-top:0">
        <b>機器人不再 24 小時運作</b><br />
        以前是開小號整天待在渦房裡監視公開渦，小號會被封、要一直開新的。
        現在改成開著插件的玩家在渦房時順手回報 —— 開插件的人越多，通報越完整；
        沒人開著插件的時段就沒有通報。
      </div>
    </div>`;
  return head("渦通報", "公開渦自動發到 Discord 的渦碼分享區。") + state + toggle + what + why;
};
