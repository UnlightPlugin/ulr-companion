// 牌組 › 牌組替換／人物篩選／等候套用。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 牌組 › 牌組替換 --------------------------------------------------
//
// 三選一（玩家 2026-09-24 要的）。切換時牌組庫會整份重新接上 —— 插件模式
// 第一次接上會把 Deck2／Deck3 收進庫裡清空，那件事一定要寫在選項旁邊。
const DECK_MODE_TIP =
  "牌組庫的牌組存在這台電腦（有開跨電腦同步的話也存在 Cloudflare Workers），四種房間（任務、渦、亞歷山卓城、迪特赫姆）各一組。" +
  "兩種模式用的是同一份牌組庫，切來切去不會弄丟牌組。";

PAGES["deck/deckmode"] = () => {
  const mode = snap?.profile.deckMode ?? "plugin";
  const opt = (value, label, hint) => `<label class="toggle">
      <input type="radio" name="deckMode" value="${value}" ${mode === value ? "checked" : ""} />
      <span><b>${label}</b><div class="hint">${hint}</div></span>
    </label>`;
  return (
    head("牌組替換") +
    `<div class="card">
       <div class="dim" style="margin-bottom:6px">每個房間用哪些牌組${info(DECK_MODE_TIP)}</div>
       ${opt(
         "plugin",
         "插件模式",
         "每個房間存任意多副，全部經過牌組一切換（◀▶ 切的是這一房的牌組）。" +
           "牌組二、三會收進牌組庫並清空，所以每一張卡都能放進任何一副。",
       )}
       ${opt(
         "official",
         "官方三牌組",
         "進入每個房間時，換上那個房間的三副（牌組庫裡那一房的前三副）。" +
           "◀▶ 照官方切牌組一～三；三副共用卡池，跟官方一樣。",
       )}
       ${opt("off", "關閉", "插件不碰牌組，牌組編輯畫面與房間都是官方原樣。")}
     </div>`
  );
};

// --- 牌組 › 人物篩選 --------------------------------------------------
//
// 玩家 2026-09-26：原版「抽出」一次只看得到五個角色。遊戲裡「抽出」左邊多一顆
// [Chara]，按下去卡片格線換成全部角色（一張縮一半，12×6 一頁放完）。這一頁只
// 決定每個角色拿哪一張卡代表。
const CHARA_PICKER_TIP =
  "在遊戲的牌組編輯畫面「抽出」左邊按 Chara，卡片區會換成持有角色一覽，點一張勾選／取消那個角色（可以勾好幾個，跟「抽出」一樣）；再按一次 Chara 收起來。" +
  "原版「抽出」下拉照常能用，兩邊看的是同一個篩選。" +
  "手上沒有指定的那一張時，用等級最接近的（例如選 L5 但只有 L4，就顯示 L4）；一張都沒有的角色不顯示。";
const FAVORITE_TIP =
  "預覽區右下的「最愛卡片」鈕：把正在看的那一張卡加入／移出最愛（只算那一張，例如 R1 史特靈）。" +
  "「1 Page」右邊的 Favorite 鈕：按下去只顯示最愛卡片，再按一次回到全部。" +
  "Event 分頁也一樣：預覽事件卡時右下的「最愛卡片」收進最愛，格線右下的 Favorite 鈕只顯示最愛的事件卡（跟角色卡的最愛分開記）。" +
  "最愛存在牌組庫裡，有開跨電腦同步的話跟牌組一起同步到其他電腦（牌組替換選「關閉」時用不到）。";
const CHARA_WEAPON_TIP =
  "Equipment 分頁一律把通用武排在最前面、素材（異化礦材、魔之系列）排最後。" +
  "「抽出」位置的 Chara Weapon 鈕：按下去只顯示通用武與目前牌組角色的專武，素材與手動隱藏的不顯示；再按一次回到全部。" +
  "預覽武器時右下的「隱藏裝備」鈕：把很少用的（叮噹星、可可果之類）藏起來，只在 Chara Weapon 開著時生效。" +
  "隱藏清單跟最愛一樣存在牌組庫、跟著跨電腦同步。";

PAGES["deck/chara"] = () => {
  const mode = snap?.profile.charaPicker ?? "L5";
  const opt = (value, label) => `<label class="toggle">
      <input type="radio" name="charaPicker" value="${value}" ${mode === value ? "checked" : ""} />
      <span><b>${label}</b></span>
    </label>`;
  return (
    head("人物篩選") +
    `<div class="card">
       <div class="dim" style="margin-bottom:6px">角色一覽用哪一張卡代表${info(CHARA_PICKER_TIP)}</div>
       ${opt("L1", "L1")}
       ${opt("L2", "L2")}
       ${opt("L3", "L3")}
       ${opt("L4", "L4")}
       ${opt("L5", "L5")}
       ${opt("R", "最高等 R 卡")}
       ${opt("off", "關閉")}
     </div>
     <div class="card">
       <div class="dim">最愛卡片${info(FAVORITE_TIP)}</div>
     </div>
     <div class="card">
       <div class="dim">Chara Weapon 與隱藏裝備${info(CHARA_WEAPON_TIP)}</div>
     </div>`
  );
};

// --- 牌組 › 等候套用 --------------------------------------------------
//
// ⚠ **這一頁刻意只有一格。** 說明全部走 tooltip（ⓘ）—— 面板上多一段字
// 的代價不是那一段字本身，是它會把「這裡只有一個東西可以調」變成
// 「這裡有一堆東西要讀」。
const APPLY_TIP =
  "切了牌組之後等這麼久，才把它寫進伺服器。" +
  "人在牌組編輯畫面時看到的變化是即時的 —— 等的只有伺服器那一份。" +
  "按下開戰／開始任務時會無視這個秒數：那一下會先攔下來，套好牌組才放行。" +
  "0 = 切了馬上寫。";

PAGES["deck/apply"] = () => {
  const seconds = snap?.profile.applyDelaySeconds ?? 3;
  const lim = snap?.limits ?? {};
  const min = lim.minApplyDelay ?? 0;
  const max = lim.maxApplyDelay ?? 30;
  return (
    head("等候套用") +
    `<div class="card">
       <div class="row">
         <span class="dim">切換牌組後等待${info(APPLY_TIP)}</span>
         <span>
           <input id="applyDelay" type="number" min="${min}" max="${max}" step="0.5"
                  style="width:5em" value="${seconds}" /> 秒
         </span>
       </div>
     </div>` +
    deckSyncCard()
  );
};

const DECK_SYNC_TIP =
  "牌組庫存到 Cloudflare Workers（插件作者架的），同一個角色在另一台電腦登入時自動同步（新增、改牌、改名、刪除、排序都會過去）。" +
  "上面的鍵是角色 id 的雜湊，文件裡沒有玩家名字；每一台電腦「這一房上次選哪一副」各自記。" +
  "兩台同時改同一副時，後改的那一邊贏。連不上就只用這台電腦的，不會把牌組清掉。";

function deckSyncCard() {
  const on = snap?.profile.deckCloudSync !== false;
  const st = snap?.deckSync ?? null;
  const when = st ? new Date(st.at).toLocaleTimeString() : "";
  const line = !on
    ? "已關閉"
    : st === null
      ? "等牌組庫接上"
      : `${st.ok ? "✓" : "⚠"} ${esc(st.text)}（${when}）`;
  return `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="deckCloudSyncOn" ${on ? "checked" : ""} />
        <span><b>牌組跨電腦同步</b>${info(DECK_SYNC_TIP)}
          <div class="hint">${line}</div>
        </span>
      </label>
    </div>`;
}
