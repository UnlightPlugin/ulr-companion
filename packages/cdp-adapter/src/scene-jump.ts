/**
 * 不經過大廳直接換場景 —— 問路與清場
 * ====================================
 * 兩支補丁都要「跳過大廳、直接把玩家帶到某一房」：`patch-nav`（返回鈕左邊
 * 的直連捷徑）與 `patch-raid-surrender`（渦戰裡的投降）。跳法一樣，所以問路
 * 與清場這兩段住在這裡，兩邊共用 —— 兩份會漂移，而漂移的那一份就是下次的 bug。
 *
 * ## 問路：`ulrAskPort(G, event, timeoutMs)`
 *
 * 任務房／渦房的場景要 `{id, host, port}` 才開得起來（大廳那兩顆鈕做的就是
 * `socket.fetch("quest_port" / "raid_port")` → `[host, port]`）。**不能拿
 * `K.Lobby.socket` 直接問** —— 離開大廳時它已經 disconnect 了，但 `url` 還讀
 * 得到，照它的 url 另開一條臨時 WSClient，問完就關。這條連線不必 register，
 * 只送 `quest_port`／`raid_port` 這種純問路的事件（`Moon/對戰.py` 的 JS_直達
 * 同一條路，2026-08-30 起實跑至今）。
 *
 * ## 清場：`ulrStopContentScenes(G, persistent, keep)`
 *
 * 跳之前先把所有**非常駐**場景 stop 掉，再用 SceneManager 層的
 * `G.scene.start(目標)` 開目標。理由（`Moon/對戰.py` 2026-08-30 用一場壞掉的
 * 渦戰換來的）：戰鬥畫面不是一個場景，是一疊 —— BackA／Log／AttackPhaseA／
 * AtkDicerollA／AtkResultA／Item 都是 `scene.launch` 出來的，只 stop MainA
 * 它們照樣活著，繼續畫自己那層，畫面就是一團疊影。
 *
 * 常駐場景（MatchBoot／ConnectionCheck／Friend／Loader／MainAAssets／Bug／dev）
 * **一個都不能收**：它們在每一個畫面的場景表裡都在，是底層不是內容。
 *
 * `keep` 是「這一個不要收」（nav 傳目標場景，照 JS_直達 的寫法）；傳 `null`
 * 就連目標一起收 —— 渦戰投降要這樣，因為那時渦房是 **sleeping** 的（戰鬥期間
 * 沒被 stop），直接 `start` 一個 sleeping 的場景 Phaser 不會先 shutdown，舊的
 * 顯示物件與舊的渦伺服器連線都會留著；先 stop 它，它的 `shutdown` 會把
 * socket 收掉，再 start 就是乾淨的一房。
 *
 * ⚠ 收之前先把每個場景的 bgm 停掉：淡出（scene_end）順手做的就是把 BGM tween
 * 到 0，不走淡出就得自己收，不然舊畫面的曲子會蓋在目的地上。
 *
 * ⚠ 先把名單抓完再動手 —— 邊走 `scenes` 邊 stop 是在改自己腳下的地板。
 *
 * ⚠⚠ 這段住在 template literal 裡，**不能出現反引號**。
 */

/** 常駐場景。**一個都不能 stop。** 跟 `Moon/對戰.py` 同一份名單。 */
export const JUMP_PERSISTENT_SCENES: readonly string[] = [
  "MatchBoot",
  "ConnectionCheck",
  "Friend",
  "Loader",
  "MainAAssets",
  "Bug",
  "dev",
];

export const SCENE_JUMP_SNIPPET = `
  function ulrAskPort(G, event, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var lobby = G.scene.keys.Lobby && G.scene.keys.Lobby.socket;
      if (!lobby || !lobby.url) return reject(new Error("讀不到大廳伺服器的位址"));
      var s;
      try { s = new (lobby.constructor)(lobby.url, lobby.protocols); }
      catch (e) { return reject(new Error("開不了臨時連線：" + String(e && e.message))); }
      var done = false;
      function finish(err, val) {
        if (done) return;
        done = true;
        try { s.disconnect(); } catch (e) {}
        if (err) reject(err); else resolve(val);
      }
      setTimeout(function () { finish(new Error("等 " + event + " 超過 " + timeoutMs + "ms")); }, timeoutMs);
      var p;
      try { p = s.fetch(event); } catch (e) { return finish(e); }
      p.then(function (r) {
        if (!Array.isArray(r) || r.length < 2) return finish(new Error(event + " 回的不是 [host, port]"));
        finish(null, { host: r[0], port: r[1] });
      }, function (e) { finish(e || new Error(event + " 失敗")); });
    });
  }

  function ulrStopContentScenes(G, persistent, keep) {
    var K = G.scene.keys;
    var skip = {};
    for (var i = 0; i < persistent.length; i++) skip[persistent[i]] = 1;
    var list = [];
    G.scene.scenes.forEach(function (s) {
      var k = s.sys.settings.key, st = s.sys.settings.status;
      if (skip[k] || (keep !== null && k === keep)) return;
      if (st === 5 || st === 6 || st === 7) list.push(k);   // RUNNING / PAUSED / SLEEPING
    });
    for (var j = 0; j < list.length; j++) {
      try { var sc = K[list[j]]; if (sc && sc.bgm && sc.bgm.stop) sc.bgm.stop(); } catch (e) {}
      try { G.scene.stop(list[j]); } catch (e) {}
    }
    return list;
  }
`;
