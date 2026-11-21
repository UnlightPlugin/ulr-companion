// 內容區的事件委派（點擊、改值、拖曳）。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// =====================================================================
// 事件（委派：內容是每次重畫的，不能直接綁在元素上）
// =====================================================================
$("content").addEventListener("change", (e) => {
  const t = e.target;
  // ⚠ 地點改了要**立刻**存。這一頁沒有存檔鈕，而下一份狀態推播就會照
  // 設定檔重畫 —— 不存的話選單會自己彈回舊值。
  if (t.id === "mStage") return void saveStagePick(t.value);
  if (t.id === "costInGameOn") {
    // 勾選框是 INPUT，焦點還在它身上時 apply() 不重畫（isEditing）—— 底下那句
    // 說明要換，自己補畫。
    return void window.ulr.cost.inGame(t.checked).then((s) => {
      apply(s);
      renderBody();
    });
  }
  if (t.id === "ready") return void set({ readyEnabled: t.checked });
  if (t.id === "kifuRecordOn") {
    return void window.ulr.kifu.record(t.checked).then(() => {
      if (snap !== null) snap.profile.kifuRecord = t.checked;
      renderBody();
    });
  }
  if (t.id === "cardCounterOn") {
    return void window.ulr.kifu.counter(t.checked).then(() => {
      if (snap !== null) snap.profile.cardCounter = t.checked;
      renderBody();
    });
  }
  if (t.id === "seconds") {
    dragging = false;
    return void set({ phaseSeconds: Number(t.value) });
  }
  if (t.id === "tintPick") {
    return void window.ulr.setReadyTint(parseInt(t.value.slice(1), 16)).then(apply);
  }
  if (t.name === "raidRewardMode" && t.checked) return void applyRaidRewardMode(t.value);
  if (t.name === "deckMode" && t.checked) {
    return void window.ulr.deck.mode(t.value).then((saved) => {
      if (snap !== null) snap.profile.deckMode = saved;
      renderBody();
    });
  }
  if (t.name === "charaPicker" && t.checked) {
    return void window.ulr.deck.charaPicker(t.value).then((saved) => {
      if (snap !== null) snap.profile.charaPicker = saved;
      renderBody();
    });
  }
  if (t.id === "deckCloudSyncOn") {
    return void window.ulr.deck.cloudSync(t.checked).then((saved) => {
      if (snap !== null) snap.profile.deckCloudSync = saved;
      renderBody();
    });
  }
  if (t.id === "raidShareOn") {
    return void window.ulr.raid.share(t.checked).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  if (t.id === "raidTeamShareOn") {
    return void window.ulr.raid.teamShare(t.checked).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  if (t.id === "raidAutoDeleteOn") {
    return void window.ulr.raid.autoDelete(t.checked).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  if (t.id === "raidHistoryButtonOn") {
    return void window.ulr.raid.historyButton(t.checked).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  if (t.id === "raidDiscoverRulesOn") {
    return void window.ulr.raid.discoverRulesOn(t.checked).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  if (t.id === "raidDiscoverSkipOn") {
    return void window.ulr.raid.discoverSkip(t.checked).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  // 發現渦的規則格（一格或整組）：data-dkeys 是逗號隔開的規則鍵
  if (t.dataset.dkeys && t.value) {
    return void window.ulr.raid.discoverRule(t.dataset.dkeys.split(","), t.value).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  if (t.id === "raidItemShortcutOn") {
    return void window.ulr.raid.itemShortcut(t.checked).then((s) => {
      rstate = s;
      renderBody();
    });
  }
  if (t.id === "questStackShortcutOn" || t.id === "questPassShortcutOn") {
    const part = t.id === "questStackShortcutOn" ? "stack" : "passes";
    return void window.ulr.quest.itemShortcut(part, t.checked).then((s) => {
      qstate = s;
      renderBody();
    });
  }
  if (t.id === "questTreasureOn") {
    return void window.ulr.quest.treasure(t.checked).then((s) => {
      qstate = s;
      renderBody();
    });
  }
  if (t.id === "questSkipResultOn") {
    return void window.ulr.quest.skipResult(t.checked).then((s) => {
      qstate = s;
      renderBody();
    });
  }
  if ((t.name === "questRewardPanel" || t.name === "questEndPanel") && t.checked) {
    const part = t.name === "questRewardPanel" ? "reward" : "end";
    return void window.ulr.quest.panel(part, t.value).then((s) => {
      qstate = s;
      renderBody();
    });
  }
  if (t.name === "bonusItemMode" && t.checked) {
    return void window.ulr.bonus.mode(t.value).then((s) => {
      bstate = s;
      renderBody();
    });
  }
  if (t.id === "bonusSkipEndOn") {
    return void window.ulr.bonus.skipEnd(t.checked).then((s) => {
      bstate = s;
      renderBody();
    });
  }
  if (t.id === "bonusRescueFastOn") {
    return void window.ulr.bonus.rescueFast(t.checked).then((s) => {
      bstate = s;
      renderBody();
    });
  }
  if (t.id === "bonusFastOn") {
    return void window.ulr.bonus.fast(t.checked).then((s) => {
      bstate = s;
      renderBody();
    });
  }
  if (t.id === "bonusHighLowOn") {
    return void window.ulr.bonus.highLow(t.checked).then((s) => {
      bstate = s;
      renderBody();
    });
  }
  if (t.name === "bonusItemOrder" && t.checked) {
    return void window.ulr.bonus.order(t.value).then((s) => {
      bstate = s;
      renderBody();
    });
  }
  if (t.dataset.climb !== undefined) return void applyBonusClimb(t);
  if (t.id === "dietStackOn" || t.id === "dietGemUpOn") {
    const part = t.id === "dietStackOn" ? "dietStack" : "gemUp";
    return void window.ulr.diet.toggle(part, t.checked).then((s) => {
      dstate = s;
      renderBody();
    });
  }
  if (
    (t.name === "surrenderConfirm" || t.name === "surrenderPlace" || t.name === "surrenderWin") &&
    t.checked
  ) {
    const part =
      t.name === "surrenderConfirm"
        ? "noConfirm"
        : t.name === "surrenderWin"
          ? "winSkip"
          : "outside";
    const on = t.value === "direct" || t.value === "outside" || t.value === "skip";
    return void window.ulr.diet.surrender(part, on).then((s) => {
      dstate = s;
      renderBody();
    });
  }
  if (t.id === "stagesOn") {
    return void window.ulr.stages.set(t.checked).then((s) => {
      sstate = s;
      renderBody();
    });
  }
  // 自己打的幅度。⚠ 走 `change` 而不是 `input`：打「0.05」的中途會經過
  // 「0」與「0.0」，而 0 是非法值（上下鍵完全不動）—— 每打一個字就送一次
  // 的話，主程序會把中途那些夾成 1 再回推，玩家看到輸入框自己跳。
  // 同 `edStep` 走 `change`：打「0.5」的中途會經過 0，而 0 的意思是
  // 「切了馬上寫」—— 每打一個字就送一次會讓輸入框自己跳。
  if (t.id === "applyDelay") return void applyDeckDelay(t.value);
  if (t.id === "edStep") return void applyEditStep(t.value);
  // 同 `edStep` 走 `change` 而不是 `input`：打「0.25」的中途會經過 0 與 0.2，
  // 而 0 的意思是「關掉檢查」—— 每打一個字就送一次會讓開關自己跳。
  if (t.id === "edUnit") return void applyEditUnit(t.value);
  if (t.id === "atLogin") return void options({ launchAtLogin: t.checked });
  if (t.id === "startMin") return void options({ startMinimized: t.checked });
  if (t.id === "multi") return void options({ multiProfile: t.checked });
  if (t.id === "clientKind") {
    t.disabled = true;
    return void window.ulr.setClientKind(t.value);
  }

  const row = t.closest("tr[data-id]");
  if (row && t.dataset.field) {
    editing = null;
    const patch = { [t.dataset.field]: t.value };
    return void window.ulr.profiles.edit(row.dataset.id, patch).then(apply);
  }
});

$("content").addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "seconds") {
    dragging = true;
    $("secLabel").textContent = t.value;
  }
  // 打字時記住是誰在被編輯，重畫後要把它還原（見 renderBody 的呼叫點）
  if (t.closest("tr[data-id]")) editing = t;

  // --- 編輯 COST ---
  //
  // ⚠ **改一格不重畫整頁。** 角色那一頁有 700 個欄位，重畫會把游標踢掉、
  // 捲軸跳回頂端，而玩家正在一個一個調數字。只更新那一格的樣式與計數。
  if (t.dataset.t !== undefined && t.dataset.k !== undefined) {
    editing = t;
    const n = Number(t.value);
    if (t.value !== "" && Number.isFinite(n)) ed.draft[t.dataset.t][t.dataset.k] = n;
    // ⚠ 整組換掉，不能只 toggle 一個 class —— 顏色是**價差的階級**，
    // 打字時每按一個鍵都可能換一階（或換一邊）。舊的階級留在身上的話，
    // 兩個 `--dfg` 會同時中，格子的顏色由 CSS 的先後順序決定而不是數字。
    // 這幾個 class 是這個 input 身上唯一的 class，整個蓋掉是安全的。
    t.className = edDeltaClass(t.dataset.t, t.dataset.k);
    // 說明也要跟著改 —— 色階只分五階，「到底差幾 C」看的是這一行，
    // 留著上一次的數字比沒有還糟。第一行（是哪一張）不會變，留著。
    t.title = `${t.title.split("\n")[0]}\n${edDeltaText(t.dataset.t, t.dataset.k)}`;
    edMsg = null;
    const save = $("edSave");
    if (save) save.disabled = edUnsavedCount() === 0;
    return;
  }
  // --- 編輯規則（壓 C 區間）---
  //
  // 改一格就要重算重疊、縫隙與試算表 —— 但**只重畫那幾塊**（`rlRefresh`），
  // 不整頁重畫，否則正在打字的輸入框會連焦點一起被換掉。
  if (t.dataset.rb !== undefined && rl !== null) {
    editing = t;
    const band = rl.bands[Number(t.dataset.rb)];
    if (band) {
      const raw = t.value.trim();
      const n = Number(raw);
      if (t.dataset.rf === "maxGap") {
        // ⚠ 空白＝無上界，**不是 0**。`Number("")` 是 0，那會把
        // 「14 以上」變成「14 到 0」—— 一段不可能命中的區間。
        band.maxGap = raw === "" ? null : Number.isFinite(n) ? n : band.maxGap;
      } else if (raw !== "" && Number.isFinite(n)) {
        band[t.dataset.rf] = n;
      }
    }
    rlMsg = null;
    return rlRefresh();
  }
  if (t.id === "rlVersion") {
    editing = t;
    return;
  }
  // --- 編輯描述 ---
  //
  // ⚠ 只更新草稿與存檔鈕，**不重畫** —— 這一頁全是輸入框，重畫會把游標
  // 連同打到一半的字一起換掉。
  if (t.dataset.rd !== undefined && rd?.meta) {
    editing = t;
    const key = t.dataset.rd;
    rd.meta[key] = key === "teamCostLimit" ? Number(t.value) : t.value;
    rdMsg = null;
    const save = $("rdSave");
    if (save) save.disabled = !rdDirty();
    const cell = $("rdDirtyCell");
    if (cell) {
      cell.innerHTML = rdDirty()
        ? '<b class="warn">有改動</b>'
        : '<span class="dim">沒有，都存好了</span>';
    }
    return;
  }
  if (t.id === "edFilter") {
    edFilter = t.value;
    editing = t;
    // 篩選要立刻反映，但只重畫清單那一塊，不動上面的表頭與輸入焦點。
    const cat = ed?.catalog;
    const box = $("content").querySelector(".card:last-child");
    if (cat && box) {
      box.innerHTML =
        edTab === "characters"
          ? edCharacters(cat)
          : edTab === "monsters"
            ? edMonsters(cat)
            : edTab === "equipment"
              ? edEquipment(cat)
              : edEvents(cat);
    }
    return;
  }
});

$("content").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  // --- 戰鬥 › 牌譜 ---
  if (btn.dataset.kifuplay !== undefined) return void window.ulr.kifu.play(btn.dataset.kifuplay);
  if (btn.dataset.kifuingame !== undefined)
    return void window.ulr.kifu.playInGame(btn.dataset.kifuingame);

  // --- 模組 › 卡面替換 ---
  if (btn.id === "modsOpen") return void window.ulr.mods.cardsOpen();
  if (btn.id === "modsReload") {
    btn.disabled = true;
    return void window.ulr.mods.cardsReload().then((s) => {
      mstate = s;
      renderBody();
    });
  }
  if (btn.id === "modsOpenBlanks") {
    return void window.ulr.mods.cardsOpenBlanks().then((s) => {
      mstate = s;
      renderBody();
    });
  }

  // --- 編輯 COST ---
  if (btn.dataset.edtab !== undefined) {
    edTab = btn.dataset.edtab;
    edFilter = "";
    return renderBody();
  }
  if (btn.id === "edCatalog") {
    btn.disabled = true;
    btn.textContent = "讀取中…";
    return void window.ulr.editor.refreshCatalog().then((payload) => {
      // ⚠ 重讀名冊會換掉「原價」的基準，所以草稿要跟著重建 —— 但**玩家
      // 已經改過的值不能丟**。decorate() 是從規則檔重建的，而規則檔就是
      // 上一次存檔的內容，所以這裡把還沒存的改動疊回去。
      const keep = ed?.draft ?? null;
      ed = decorate(payload);
      if (keep !== null) {
        for (const t of ED_TABS)
          for (const k of Object.keys(keep[t.id] ?? {}))
            if (ed.draft[t.id][k] !== undefined) ed.draft[t.id][k] = keep[t.id][k];
      }
      renderBody();
    });
  }
  if (btn.id === "edSave") {
    const version = $("edVersion")?.value.trim() ?? ed.rule.version;
    // ⚠⚠ **檔名要在這裡先抓下來，不能等 then 裡面才讀 `ed.rule`。**
    // 存檔成功會讓主程序推一份新狀態過來，而 apply() 看到核對碼變了就把
    // `ed` 設成 null —— 那份推播**比 invoke 的回覆先到**。在 then 裡讀
    // `ed.rule.fileName` 會拋 TypeError，而 promise 會把它吞掉：檔案存好了，
    // 玩家卻什麼提示都沒有。2026-08-16 實測踩到，兩次都以為是時序問題。
    const fileName = ed.rule.fileName;
    btn.disabled = true;
    return void window.ulr.editor.save({ tables: ed.draft, version }).then((r) => {
      edMsg = r.ok
        ? { text: `已存回 ${fileName}（${r.version}，核對碼 ${r.shortHash}）`, bad: false }
        : { text: r.error ?? "存檔失敗", bad: true };
      // ⚠ 不自己 `edLoad(true)`：狀態推播已經把 `ed` 丟掉了，重畫時
      // 會自然重拉一次。這裡再拉一次只會兩份 payload 賽跑。
      // 但**一定要重畫** —— 兩個 promise 的先後沒有保證，少了這一行時
      // 訊息可能落在最後一次重畫之後，變成存了檔卻沒有任何回應。
      renderBody();
    });
  }
  if (btn.dataset.step !== undefined) return void applyEditStep(btn.dataset.step);
  if (btn.dataset.unit !== undefined) return void applyEditUnit(btn.dataset.unit);
  if (btn.id === "edOnlyOff") {
    edOnlyOff = !edOnlyOff;
    return void renderBody();
  }
  if (btn.id === "edHideLocked") {
    edHideLocked = !edHideLocked;
    return void renderBody();
  }
  if (btn.id === "edResetTab") {
    const label = ED_TABS.find((t) => t.id === edTab)?.label ?? edTab;
    // ⚠ 只動當前這一頁。四張表一起清掉是很難反悔的操作，而玩家按的是
    // 「這一頁」那顆按鈕。
    for (const k of Object.keys(ed.base[edTab])) ed.draft[edTab][k] = ed.base[edTab][k];
    edMsg = { text: `${label}已全部改回原價（還沒存檔）`, bad: false };
    return renderBody();
  }

  // --- 編輯規則（壓 C 區間）---
  if (btn.dataset.rbdel !== undefined && rl !== null) {
    rl.bands.splice(Number(btn.dataset.rbdel), 1);
    rlMsg = null;
    return renderBody();
  }
  if (btn.id === "rlAdd" && rl !== null) {
    // 接在最後一段後面起跳，玩家少改一個欄位。最後一段沒有上界時就從
    // 它的下界 +1 起 —— 那一定會重疊，而重疊會立刻被上面的檢查點名，
    // 比安靜地插一段 0 進去好懂。
    const last = rl.bands[rl.bands.length - 1];
    const start = last ? (last.maxGap === null ? last.minGap + 1 : last.maxGap + 1) : 7;
    rl.bands.push({ minGap: start, maxGap: null, extraCost: 0 });
    rlMsg = null;
    return renderBody();
  }
  if (btn.id === "rlSort" && rl !== null) {
    // ⚠ 順序**有意義**：引擎取第一個命中的區間。沒重疊時排序不改變任何
    // 結果，有重疊時排序會改變 —— 所以排完要讓玩家自己看那個警告。
    rl.bands.sort((a, b) => a.minGap - b.minGap);
    rlMsg = null;
    return renderBody();
  }
  if (btn.id === "rlSnap" && rl !== null) {
    // 每一段的上界頂到下一段起點的前 0.01（`shinon/squeeze-band` 的 x.99
    // 就是這樣來的）。最後一段不動 —— 它要嘛本來就無上界，要嘛作者是
    // 刻意讓超大差距不罰。
    const order = rl.bands.map((b, i) => ({ b, i })).sort((x, y) => x.b.minGap - y.b.minGap);
    for (let n = 0; n < order.length - 1; n++) {
      const cur = order[n].b;
      const next = order[n + 1].b;
      if (cur.maxGap === null) continue;
      if (next.minGap > cur.maxGap) cur.maxGap = Math.round((next.minGap - 0.01) * 100) / 100;
    }
    rlMsg = { text: "已把每一段的上界頂到下一段（還沒存檔）", bad: false };
    return renderBody();
  }
  if (btn.id === "rlOfficial" && rl !== null) {
    rl.bands = RL_OFFICIAL.map((b) => ({ ...b }));
    rlMsg = { text: "已換成原版的兩段（還沒存檔）", bad: false };
    return renderBody();
  }
  if (btn.id === "rlClear" && rl !== null) {
    rl.bands = [];
    rlMsg = { text: "已清空 —— 存檔之後這份規則完全不壓 C", bad: false };
    return renderBody();
  }
  if (btn.id === "rdSave" && rd?.meta) {
    // ⚠ 檔名先抓下來 —— 存檔會讓主程序推一份新狀態過來，而 apply() 看到
    // 核對碼變了就把 `rd` 設成 null（那份推播比 invoke 的回覆先到）。
    const fileName = rd.rule.fileName;
    btn.disabled = true;
    return void window.ulr.editor
      // ⚠ 只送 `meta`。少送 `tables` / `compression` 的意思是「別動它們」，
      // 不是「清空」（主程序的 saveEditedRule 會沿用檔案裡那份）。
      .save({ meta: rd.meta })
      .then((r) => {
        rdMsg = r.ok
          ? { text: `已存回 ${fileName}（${r.version}，核對碼 ${r.shortHash}）`, bad: false }
          : { text: r.error ?? "存檔失敗", bad: true };
        renderBody();
      });
  }
  if (btn.id === "rlSave" && rl !== null) {
    // ⚠ 檔名先抓下來。存檔會讓主程序推一份新狀態過來，而 apply() 看到
    // 核對碼變了就把 `rl` 設成 null —— 那份推播比 invoke 的回覆先到。
    // 編輯 COST 那邊踩過同一件事。
    const fileName = rl.rule.fileName;
    const version = $("rlVersion")?.value.trim() ?? rl.rule.version;
    const bands = rl.bands.map((b) => ({
      minGap: b.minGap,
      // 主程序那邊 null 就是「沒有上界」（`sanitizeBand`）。
      maxGap: b.maxGap,
      extraCost: b.extraCost,
    }));
    btn.disabled = true;
    return void window.ulr.editor
      .save({
        // ⚠ **不送 `tables`。** 主程序看到沒有這個欄位就沿用檔案裡的四張
        // 表；送一份空的等於把 1186 筆價格全洗掉（而空表是合法規則，
        // 不會報錯，只會讓每張卡變成 99C）。
        compression: bands.length === 0 ? { type: "none" } : { type: "gap-band-v1", bands },
        version,
      })
      .then((r) => {
        rlMsg = r.ok
          ? { text: `已存回 ${fileName}（${r.version}，核對碼 ${r.shortHash}）`, bad: false }
          : { text: r.error ?? "存檔失敗", bad: true };
        renderBody();
      });
  }

  if (btn.dataset.tint !== undefined) {
    const v = btn.dataset.tint === "" ? null : Number(btn.dataset.tint);
    return void window.ulr.setReadyTint(v).then(apply);
  }
  if (btn.id === "addProfile") {
    return void window.ulr.profiles.add().then(apply);
  }
  if (btn.id === "copyFlag") {
    // 走主程序的剪貼簿（見 preload）。要玩家自己把那一行一字不差地打進
    // Steam，就是在製造一個「打錯了但完全看不出來」的失敗。
    return void window.ulr.copyDebugFlag().then(() => {
      btn.textContent = "已複製";
      setTimeout(() => (btn.textContent = "複製"), 1500);
    });
  }
  if (btn.id === "stagesRetry") {
    return void window.ulr.stages.retry().then((s) => {
      sstate = s;
      renderBody();
    });
  }
  if (btn.id === "updateCheck") {
    updBusy = true;
    updMsg = null;
    renderBody();
    return void window.ulr
      .checkUpdate()
      .then((m) => (updMsg = m))
      .catch((e) => (updMsg = `檢查失敗：${e?.message ?? e}`))
      .finally(() => {
        updBusy = false;
        renderBody();
      });
  }
  if (btn.id === "costPick") return void window.ulr.cost.pick().then(apply);
  if (btn.id === "costClear") return void window.ulr.cost.clear().then(apply);
  if (btn.id === "costModeDefault") return void window.ulr.cost.mode("default").then(apply);
  if (btn.id === "costModeOff") return void window.ulr.cost.mode("off").then(apply);
  if (btn.id === "costModeFile") {
    // ⚠ 切到「自己的規則檔」而還沒選過檔的話，直接把檔案選擇框開起來 ——
    // 不然畫面會停在一個什麼都沒有的狀態，而玩家剛剛才按了一顆按鈕。
    return void window.ulr.cost.mode("file").then((s) => {
      apply(s);
      if (s?.costRule === null) void window.ulr.cost.pick().then(apply);
    });
  }
  if (btn.dataset.link) {
    return void window.ulr.openExternal(btn.dataset.link);
  }
  // 設置底下的另一格（同一個大分頁，只換側欄）。
  if (btn.dataset.goto) {
    sub = btn.dataset.goto;
    renderChrome();
    return void renderBody();
  }
  // 網頁版那幾顆：結果講在按鈕旁邊（webMsg），不跳對話框。
  const web = (p, at = null) =>
    void p.then((r) => {
      if (r?.text) webMsg = { text: r.text, bad: !r.ok, at };
      renderBody();
    });
  if (btn.id === "browserOpen") {
    btn.disabled = true;
    btn.textContent = "開啟中…";
    return web(window.ulr.browser.open());
  }
  if (btn.dataset.browser) {
    btn.disabled = true;
    btn.textContent = "開啟中…";
    return web(window.ulr.browser.launch(btn.dataset.browser), "browser");
  }
  if (btn.dataset.shortcut)
    return web(window.ulr.browser.shortcut(btn.dataset.shortcut), "browser");
  if (btn.dataset.copytarget)
    return web(window.ulr.browser.copyTarget(btn.dataset.copytarget), "copy");
  if (btn.dataset.extpage) {
    btn.disabled = true;
    return web(window.ulr.browser.launch(btn.dataset.extpage, "extensions"), "ext");
  }
  if (btn.id === "browserCmd") return web(window.ulr.browser.saveCmd());
  if (btn.id === "steamExtInstall") return web(window.ulr.steamExt.install(), "ext");

  const row = btn.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  if (btn.dataset.act === "launch") return void window.ulr.profiles.launch(id).then(apply);
  if (btn.dataset.act === "dup") return void window.ulr.profiles.add(id).then(apply);
  if (btn.dataset.act === "del") return void window.ulr.profiles.remove(id).then(apply);
});

// --- 對戰地點的動作 ---------------------------------------------------
//
// ⚠ **只剩「存這一格」。** 開始／停止配對那兩支拿掉了（WP-18）：那條路
// 的入口是遊戲大廳裡那顆按鈕，而它從頭到尾都在主程序裡。畫面這邊已經沒有
// 任何一條會替玩家操作遊戲的路徑了。

/**
 * 把選好的地點存進設定檔。
 *
 * ⚠ **一定要立刻存**（不要等玩家按什麼按鈕）：這一頁沒有存檔鈕，而下一份
 * 狀態推播就會照設定檔重畫 —— 不存的話選單會自己彈回舊值。
 *
 * ⚠ 存完把主程序整理過的那份收回來。認不得的值會被夾成預設，而畫面自己
 * 留一份的話會跟設定檔漂開。
 */
function saveStagePick(value) {
  mform = { stage: value };
  return window.ulr.match.prefs(mform).then((saved) => {
    mform = { ...saved.match };
    renderBody();
  });
}

function set(prefs) {
  return window.ulr.setPrefs(prefs).then(apply);
}
function options(patch) {
  return window.ulr.setOptions(patch).then(apply);
}
