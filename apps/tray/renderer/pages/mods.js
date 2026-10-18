// 模組 › 卡面替換。
// 拆自 index.html（2026-10-18），載入順序見 index.html 底部。
"use strict";

// --- 模組 › 卡面替換 --------------------------------------------------
//
// 狀態不在 snapshot 裡（資料夾要掃、遊戲那端要問一次 CDP），開著才輪詢。
let mstate = null;
let modsTimer = null;
const onModsPage = () => tab === "mods" && sub === "cards";

function startModsPolling() {
  if (modsTimer !== null) return;
  const tick = () =>
    window.ulr.mods.cardsState().then((s) => {
      mstate = s;
      if (!onModsPage()) return;
      renderBody();
    });
  void tick();
  modsTimer = setInterval(tick, 3000);
}
function stopModsPolling() {
  if (modsTimer !== null) clearInterval(modsTimer);
  modsTimer = null;
}

function cardArtText(s, sent) {
  if (s === null) return "還沒接上遊戲 —— 開了遊戲就會自己換上";
  if (!s.installed) {
    if (sent === 0) return "資料夾裡還沒有可用的圖";
    return "還沒裝上" + (s.reason ? "：" + s.reason : "");
  }
  if (!s.atlasReady) return "已裝上，等遊戲載入卡面圖集（進大廳就有）";
  if (s.pending > 0) return `換上 ${s.applied} 張，${s.pending} 張還在解碼`;
  return `生效中：換上 ${s.applied} 張` + (s.failed.length ? `，${s.failed.length} 張沒換上` : "");
}

const CARD_ART_TIP =
  "遊戲把每張角色卡的卡面（含金框與底部 HP/ATK/DEF 標籤）烤成一張 168×240 的圖，" +
  "插件把你的 PNG 指到那一格。只改你自己畫面上的圖，對手、伺服器都不知道；" +
  "插件關掉或重開遊戲就回官方卡面（插件開著時會自己再換上）。";
const BLANK_TIP =
  "遊戲裡沒有無圖的空框，這是從 631 張官方卡面統計出來的：R 卡一張「框」（透明 PNG，疊在你的圖上面）；" +
  "L 卡兩張 ——「底」是壁紙加框（不透明，放最下面），「框」疊在人物上面。十個等級的直條顏色不同，各出一份。" +
  "336×480 是用 AI 放大的版本。要改就複製出來改 —— 插件更新時會換成新版空框。";

PAGES["mods/cards"] = () => {
  const s = mstate;
  const st = s?.status ?? null;
  const failedBy = new Map((st?.failed ?? []).map((f) => [f.frame, f.reason]));
  const state = `<div class="card">
      <div class="row"><span class="dim">狀態${info(CARD_ART_TIP)}</span><span>${esc(cardArtText(st, s?.sent ?? 0))}</span></div>
      <div class="row"><span class="dim">資料夾</span><span><code>${esc(s?.dir ?? "…")}</code></span></div>
      <div style="margin-top:8px">
        <button class="gene" id="modsOpen">開資料夾</button>
        <button class="gene" id="modsReload">重新載入</button>
      </div>
      <div class="hint">把 PNG 放進資料夾就會自己換上（一秒內）；改了圖、刪了圖也一樣。</div>
    </div>`;
  const rows = (s?.files ?? [])
    .map((f) => {
      const why = f.problem ?? (f.frame !== null ? failedBy.get(f.frame) : null) ?? null;
      const size = f.width !== null ? `${f.width}×${f.height}` : "—";
      const ok = why === null && st?.installed && st.atlasReady;
      return `<tr>
          <td><code>${esc(f.file)}</code></td>
          <td>${f.label !== null ? esc(f.label) : '<span class="dim">—</span>'}</td>
          <td>${esc(size)}</td>
          <td>${why !== null ? `<span class="warn">⚠ ${esc(why)}</span>` : ok ? "已換上" : '<span class="dim">等遊戲</span>'}</td>
        </tr>`;
    })
    .join("");
  const files = `<div class="card">
      ${
        rows === ""
          ? `<div class="hint" style="margin-top:0">資料夾是空的。照下面的步驟做一張，放進去就會出現在這裡。</div>`
          : `<table class="profiles"><thead><tr><th>檔名</th><th>哪張卡</th><th>尺寸</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table>`
      }
      ${s && !s.names ? `<div class="hint warn">還沒讀到角色名字表（接上遊戲、進到大廳後會自己讀）。在那之前檔名只認 <code>cc034_r01</code> 這種代號。</div>` : ""}
    </div>`;
  const blanks = s?.blanks ?? {};
  const small = blanks["168x240"] ?? 0;
  const large = blanks["336x480"] ?? 0;
  const blankCard = `<div class="card">
      <div class="row"><span class="dim">空框${info(BLANK_TIP)}</span>
        <span>${small + large > 0 ? `168×240 ${small} 張 · 336×480 ${large} 張` : '<span class="warn">不見了（按下面補回來）</span>'}</span></div>
      <div style="margin-top:8px">
        <button class="gene" id="modsOpenBlanks">開空框資料夾</button>
      </div>
      <div class="hint">
        插件內建，在 <code>空框\\168x240</code> 與 <code>空框\\336x480</code>：
        <code>R1_框.png</code>…<code>R5_框.png</code>、<code>L1_底.png</code>＋<code>L1_框.png</code>…<code>L5</code>。
      </div>
    </div>`;
  const howto = `<div class="card">
      <div class="hint" style="margin-top:0"><b>怎麼做一張卡面</b></div>
      <ol class="steps">
        <li>按上面的「開空框資料夾」。</li>
        <li>用繪圖軟體（Photoshop、Krita、GIMP、Photopea 都行）開 <b>168×240</b> 的新圖，或用 <code>336x480</code> 那份空框畫 <b>336×480</b> 的大圖（插件會自己縮）。</li>
        <li><b>R 卡</b>：把你的圖放最下層，再把 <code>R1_框.png</code>（照卡的等級選）疊在最上面。<br />
            <b>L 卡</b>：最下層 <code>L1_底.png</code>（壁紙），中間放去背的人物，最上面 <code>L1_框.png</code>。</li>
        <li>存成 PNG，檔名寫成 <code>史塔夏_R1.png</code>（角色名照遊戲裡的寫法）或代號 <code>cc034_r01.png</code>，放進上面那個資料夾。</li>
        <li>一秒內就換上。沒換上的話看上面的清單，那一列會寫原因。</li>
      </ol>
      <div class="hint">
        等級：L1～L5 是一般卡，R1～R5 是覺醒卡；框的直條顏色每個等級不同，記得選對。<br />
        只換你自己看到的畫面 —— 對手看到的、伺服器存的都是官方卡面。
      </div>
    </div>`;
  return (
    head("卡面替換", "把自己畫的卡面換進遊戲 —— 只在你自己的畫面上。") +
    state +
    files +
    blankCard +
    howto
  );
};

PAGES["diet/hidden"] = () => {
  const s = sstate;
  // ⚠ 第一次畫的時候還沒問到狀態。這時候**不要先畫出開關** —— 它會是沒勾的
  // 樣子，而那對已經啟用的玩家是假的（下一輪輪詢就會跳成勾的）。
  if (s === null) {
    return (
      head("隱藏地圖", "官方選單裡沒有的四張地圖，加回遊戲自己的開房選單。") +
      `<div class="card"><div class="hint">讀取中…</div></div>`
    );
  }
  const enabled = s.enabled === true;
  const st = s.status ?? null;
  const stages = s.stages ?? [];
  const added = st?.added ?? [];

  const toggle = `<div class="card">
      <label class="toggle">
        <input type="checkbox" id="stagesOn" ${enabled ? "checked" : ""} />
        <span><b>在遊戲的開房選單裡顯示隱藏地圖</b>
          <div class="hint">
            打開之後，遊戲自己的「創建對戰房間 › 對戰地點」下拉會從 11 項變成 15 項，
            多出來的四項在最下面。房名、對戰規則、密碼、AP <b>全部走官方流程</b> ——
            這裡只是把選項放回選單，開房仍然是你自己在遊戲裡按的。
          </div>
        </span>
      </label>
    </div>`;

  const state = `<div class="card">
      <div class="row"><span class="dim">狀態</span><span>${esc(stageStatusText(enabled, st))}</span></div>
      ${
        enabled && st?.installed
          ? `<div class="row"><span class="dim">已加進選單</span><span>${
              added.length
            } 張${added.length ? `（${added.map(esc).join("、")}）` : ""}</span></div>`
          : ""
      }
      ${
        st?.lang
          ? `<div class="row"><span class="dim">遊戲語言</span><span><code>${esc(st.lang)}</code></span></div>`
          : ""
      }
      ${
        enabled && st?.installed && !st.dropdownPatched
          ? `<div class="hint">選單那一格要等對話框第一次被建出來才碰得到 ——
               <b>開一次就會補上，不必開兩次</b>。</div>`
          : ""
      }
      ${st?.reason ? `<div class="hint warn">⚠ ${esc(st.reason)}</div>` : ""}
      ${
        // 頁面那支腳本已經不等了（逾時、或換過語言）——
        // 這時候唯一能做的就是再推一次，給他一個按鈕。
        enabled && st !== null && !st.installed && !st.waiting
          ? `<div class="row"><span></span><span><button id="stagesRetry">再試一次</button></span></div>`
          : ""
      }
    </div>`;

  const rows = stages
    .map(
      (g) => `<tr>
          <td><code>${esc(g.value)}</code></td>
          <td>${esc(g.name)}</td>
          <td>${added.includes(g.value) ? "已加入" : '<span class="dim">—</span>'}</td>
        </tr>`,
    )
    .join("");

  const list = `<div class="card">
      <table><thead><tr><th>代號</th><th>地圖</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  const caveat = `<div class="card">
      <div class="hint" style="margin-top:0">
        <b>要知道的三件事</b><br />
        · 客戶端有這四張的背景與房間縮圖，但還<b>沒有在這四張上打完一整場</b> ——
          真的出事只影響你自己那一場。<br />
        · 插件<b>沒有</b>改變任何伺服器判定，只是讓選項在選單上出得來；
          伺服器收不收這個代號由它自己決定。<br />
        · <b>遊戲重載會把它沖掉</b>，插件會自己補回去。
      </div>
    </div>`;

  return (
    head("隱藏地圖", "官方選單裡沒有的四張地圖，加回遊戲自己的開房選單。") +
    toggle +
    state +
    list +
    caveat
  );
};
