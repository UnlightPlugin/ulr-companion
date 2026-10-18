// 套用快照、啟動（最後載入：這時其他檔的函式與常數都已經在了）。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// =====================================================================
// 套用一份快照
// =====================================================================
/** 目前選著的規則的身分。換檔或換版本時，編輯器的草稿就作廢了。 */
function ruleSig(s) {
  return `${s?.costRule?.path ?? ""}|${s?.costRule?.version ?? ""}|${s?.costRule?.shortHash ?? ""}`;
}
let lastRuleSig = null;

function apply(next) {
  if (!next) return;
  const sig = ruleSig(next);
  // 規則換了（玩家去「Cost 表」選了別份，或我們剛存完檔）→ 手上那份草稿
  // 的基準已經不對了，丟掉重載。
  //
  // ⚠ **`edMsg` 不能一起清掉。** 存檔會讓核對碼改變，於是這個判斷成立、
  // 於是「已存回 xxx」那行字在出現的同一瞬間就被抹掉 —— 玩家按了存檔卻
  // 什麼回應都看不到。訊息本身帶著檔名與核對碼，過期也不會誤導。
  if (lastRuleSig !== null && sig !== lastRuleSig) {
    ed = null;
    rl = null;
    rd = null;
  }
  lastRuleSig = sig;
  snap = next;
  renderFooter();
  // ⚠ 拖滑桿或打字時不要重畫內容區 —— 會把游標踢掉、滑桿跳回去。
  // 狀態列照更新（它跟輸入無關，而且那才是玩家在等的資訊）。
  //
  // ⚠⚠ 這裡原本只擋 `editing`（各頁自己設的那個變數），而**配對頁的
  // 開房設定從來沒設過它** —— 於是每一次狀態推播（連線心跳、對戰狀態、
  // 記錄檔…）都會在玩家打房名打到一半時把輸入框整個換掉。現在一律問
  // `isEditing()`，那支是問瀏覽器誰有焦點，不必每一頁記得自己登記。
  if (dragging || isEditing() || (editing && document.activeElement === editing)) {
    // 玩家打完字（焦點離開）時要把錯過的那些更新補畫回來，否則畫面會停在
    // 他開始打字的那一刻。⚠ 只掛一次，而且是 `once` —— 累加的話每打一個
    // 字就多一個 listener。
    scheduleCatchUp();
    return;
  }
  // ⚠ 編輯 COST 那一頁**不跟著狀態推播重畫**。它有 700 個輸入框，而連線
  // 心跳、對戰狀態這些跟它一點關係都沒有的變動每幾秒就來一次 —— 重畫會
  // 把捲軸拉回頂端，而玩家正在第 40 位角色那一排調數字。
  // 需要重畫的兩件事（換規則、存完檔）各自都有明確的呼叫點。
  if (onEditPage() && ed !== null) return;
  // ⚠ 編輯規則那一頁同理。欄位少得多，但玩家一樣是在輸入框裡打數字，
  // 而連線心跳每幾秒就推一次 —— 重畫會把打到一半的數字連游標一起換掉。
  // 換規則與存完檔都會把 `rl` 設成 null，那時這道閘自然放行。
  if (onRulePage() && rl !== null) return;
  // 編輯描述同理 —— 整頁都是輸入框。
  if (onDescPage() && rd !== null) return;
  editing = null;
  // ⚠ 側邊那排會隨「進階：多開」增減，所以每次套用快照都要重畫，不能只在
  // 切分頁時畫。而關掉多開的那一刻若玩家正站在「配置」上，那一格已經不
  // 存在了 —— 退回第一格，不要把他留在一片空白上。
  const visible = subsOf(TABS.find((t) => t.id === tab));
  if (!visible.some((s) => s.id === sub)) sub = visible[0].id;
  renderChrome();
  renderBody();
}

// 狀態列最後一格是最近一則記錄 —— 點它看完整的。
$("fLast").addEventListener("click", () => {
  tab = "settings";
  sub = "log";
  renderChrome();
  renderBody();
});

renderChrome();
window.ulr.onState(apply);
window.ulr.state().then(apply);
