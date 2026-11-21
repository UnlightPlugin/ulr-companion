// 牌譜播放器視窗：讀資料、時間軸、步驟清單、記牌面板。畫圖交給 viewer.js。
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const KIND_TEXT = { swd: "劍", gun: "槍", shi: "防", mov: "移", spe: "特" };
  const RULES = { duel: "對戰", ranked: "排名戰", quest: "任務", raid: "渦", event: "活動" };
  let data = null;
  let viewer = null;
  let cur = 0;
  let timer = null;

  function esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  }
  const steps = () => (data ? data.replay.steps : []);

  async function load(file) {
    stop();
    $("kTitle").textContent = "讀取中…";
    data = await window.ulr.kifu.data(file);
    // 字型（BradleyGratis：卡片與傷害數字）
    for (const [family, url] of Object.entries(data.fonts || {})) {
      try {
        const f = new FontFace(family, `url("${url}")`);
        await f.load();
        document.fonts.add(f);
      } catch {
        /* 字型載不到就用替代字 */
      }
    }
    const textures = await window.KifuViewer.loadTextures(data.textures, (u) => u);
    viewer = window.KifuViewer.create($("board"), {
      replay: data.replay,
      textures,
      tables: data.tables,
    });
    const m = data.replay.meta;
    const pov = data.replay.pov;
    const opp = data.replay.opp;
    const name = (s) => (m.players && m.players[s] && m.players[s].name) || s;
    $("kTitle").textContent =
      `${RULES[m.rule] || m.rule || "戰鬥"}　${name(pov)} vs ${name(opp)}　地點 ${data.deck ? data.deck.name : m.stage}`;
    $("kWarn").textContent = (data.warnings || []).join("；");
    $("kSeek").max = String(steps().length - 1);
    renderLog();
    go(0);
  }

  function renderLog() {
    $("kLog").innerHTML = steps()
      .map((s, i) => {
        const t = s.ms / 1000;
        const mm = Math.floor(t / 60);
        const ss = Math.floor(t % 60);
        return `<li data-i="${i}" class="k-${s.kind}"><span class="t">${mm}:${String(ss).padStart(2, "0")}</span>${esc(s.text)}</li>`;
      })
      .join("");
  }

  function go(i) {
    if (!viewer) return;
    cur = Math.max(0, Math.min(i, steps().length - 1));
    viewer.show(cur);
    $("kSeek").value = String(cur);
    const st = steps()[cur].state;
    $("kPos").textContent = `${cur + 1}/${steps().length}　T${st.turn}`;
    const log = $("kLog");
    const prev = log.querySelector("li.cur");
    if (prev) prev.classList.remove("cur");
    const li = log.querySelector(`li[data-i="${cur}"]`);
    if (li) {
      li.classList.add("cur");
      li.scrollIntoView({ block: "nearest" });
    }
    renderCount(st);
  }

  /** 記牌：整疊扣掉看過的（buildReplay 已經照洗牌重算 seenIndex） */
  function renderCount(st) {
    const deck = data.deck;
    if (!deck || data.deckOk === false) {
      $("kCount").innerHTML =
        deck && data.deckOk === false
          ? `<span class="dim">這個地點的公牌跟記錄的表對不上（可能改版換牌了），不顯示記牌</span>`
          : "";
      return;
    }
    const seen = new Set(st.seenIndex);
    const unseen = deck.cards.filter((_, i) => !seen.has(i));
    const opp = st.sides[data.replay.opp];
    // 合併補上的牌（peek）當時看不到，記牌照「蓋著」算
    const hidden = opp.cards.filter(
      (c) => c && (c.card === null || c.peek) && c.src === "deck",
    ).length;
    const rows = ["swd", "gun", "shi", "mov", "spe"].map((s) => {
      let n = 0;
      let total = 0;
      const byVal = {};
      for (const c of unseen) {
        const v = Math.max(c[0] === s ? c[1] : 0, c[2] === s ? c[3] : 0);
        if (v > 0) {
          n++;
          total += v;
          byVal[v] = (byVal[v] || 0) + 1;
        }
      }
      const detail = Object.keys(byVal)
        .sort((a, b) => b - a)
        .map((v) => `${v}×${byVal[v]}`)
        .join(" ");
      return `<tr><td>${KIND_TEXT[s]}</td><td>${n}</td><td>${total}</td><td class="dim" style="text-align:left">${detail}</td></tr>`;
    });
    $("kCount").innerHTML =
      `<div>沒看過 <b>${unseen.length}</b> 張＝牌堆 ${st.deckLeft} ＋ 對手蓋著 ${hidden}${st.shuffles ? `　（洗過 ${st.shuffles} 次）` : ""}</div>` +
      `<table><tr><th>種類</th><th>張</th><th>合計</th><th style="text-align:left">數字×張</th></tr>${rows.join("")}</table>`;
  }

  function delayFor(i) {
    const sp = Number($("kSpeed").value);
    if (sp > 0) return sp;
    const s = steps();
    if (i + 1 >= s.length) return 800;
    return Math.max(60, Math.min(4000, s[i + 1].ms - s[i].ms));
  }
  function play() {
    if (timer !== null) return stop();
    $("kPlay").textContent = "⏸";
    const tick = () => {
      if (cur >= steps().length - 1) return stop();
      go(cur + 1);
      timer = setTimeout(tick, delayFor(cur));
    };
    timer = setTimeout(tick, delayFor(cur));
  }
  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    $("kPlay").textContent = "▶";
  }
  function turnJump(dir) {
    const s = steps();
    let i = cur + dir;
    while (i > 0 && i < s.length - 1 && s[i].kind !== "turn" && s[i].kind !== "start") i += dir;
    go(i);
  }

  $("kFirst").onclick = () => go(0);
  $("kLast").onclick = () => go(steps().length - 1);
  $("kPrev").onclick = () => go(cur - 1);
  $("kNext").onclick = () => go(cur + 1);
  $("kPrevTurn").onclick = () => turnJump(-1);
  $("kNextTurn").onclick = () => turnJump(1);
  $("kPlay").onclick = () => play();
  $("kSeek").oninput = (e) => go(Number(e.target.value));
  $("kLog").onclick = (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) go(Number(li.dataset.i));
  };
  document.addEventListener("keydown", (e) => {
    if (e.target && e.target.tagName === "SELECT") return;
    if (e.key === "ArrowRight") go(cur + 1);
    else if (e.key === "ArrowLeft") go(cur - 1);
    else if (e.key === "PageDown") turnJump(1);
    else if (e.key === "PageUp") turnJump(-1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(steps().length - 1);
    else if (e.key === " ") {
      e.preventDefault();
      play();
    } else return;
    e.preventDefault();
  });

  window.ulr.kifu.onFile((file) => void load(file));
  window.ulr.kifu.current().then((file) => {
    if (file) void load(file);
    else $("kTitle").textContent = "沒有指定牌譜";
  });
})();
