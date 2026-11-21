// 牌譜播放器：繪圖核心（Canvas 2D）。
//
// 托盤的播放器視窗與遊戲裡的復盤畫面共用這一支。不依賴 Phaser —— 畫的是**當時存下來的**
// 貼圖（版本快照：來源圖＋每格切法），座標照官方戰鬥畫面（2026-10-23 讀 949.js／20.js／183.js、
// 傾印跑著的 BackA／MainA 實測），所以改版之後舊牌譜照樣用當時的美術播。
//
// 用法：
//   const v = KifuViewer.create(canvas, { replay, textures, tables });
//   v.show(stepIndex);
//
// replay   buildReplay() 的結果（pov、steps[].state、steps[].text…）
// textures { key: { images: [HTMLImageElement|null], frames: { 名: [src,cx,cy,cw,ch,tx,ty,rw,rh,rot] }, bitmapFont } }
// tables   { Characters, CharaCards, … }（當時的資料表；立繪原點要 Characters[chara].standchara）
"use strict";

(function () {
  const W = 760;
  const H = 680;
  const SUIT_FRAME = { swd: "swd", gun: "gun", shi: "shi", mov: "mov", spe: "spe" };
  /** 距離 0 近、1 中、2 遠 → 官方 RangeLetters／range_* 的格名 */
  const RANGE = ["short", "middle", "long"];
  /**
   * 階段列 phase_image 停在哪一格（官方動畫的最後一格，388.js）：抽牌 phase_d 35–46、
   * 移動 phase_m 83–94；移動後第一個戰鬥階段 a1 0–11／d1 47–58，第二個 a2 12–23／d2 59–70。
   */
  function phaseFrame(st) {
    if (st.phase === "DrawPhaseA") return 46;
    if (st.phase === "MovePhaseA") return 94;
    if (st.phase === "AttackPhaseA") return st.battleRound === 2 ? 23 : 11;
    if (st.phase === "DefensePhaseA") return st.battleRound === 2 ? 70 : 58;
    return undefined;
  }

  function half(card, h) {
    for (const s of ["swd", "gun", "shi", "mov", "spe"]) {
      const v = card[s + h];
      if (typeof v === "number" && v > 0) return { suit: s, value: v };
    }
    return null;
  }

  function create(canvas, data) {
    const ctx = canvas.getContext("2d");
    canvas.width = W;
    canvas.height = H;
    const tex = data.textures || {};
    const tables = data.tables || {};
    const replay = data.replay;
    const pov = replay.pov;
    const opp = replay.opp;

    /** 畫一格。ox/oy 是原點（0～1），flip 水平翻轉，angle 角度（度）。回 false＝沒有這張圖。 */
    function frame(key, name, x, y, opt) {
      const t = tex[key];
      if (!t) return false;
      const whole = name === undefined || name === null || name === "__BASE";
      const f =
        t.frames[whole ? "__BASE" : String(name)] ||
        (whole ? firstFrame(t) || wholeImage(t) : null);
      if (!f) return false;
      const img = t.images[f[0]];
      if (!img) return false;
      const o = opt || {};
      const [, cx, cy, cw, ch, tx, ty, rw, rh] = f;
      const ox = o.ox === undefined ? 0.5 : o.ox;
      const oy = o.oy === undefined ? 0.5 : o.oy;
      const sx = o.scale === undefined ? 1 : o.scale;
      ctx.save();
      ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
      ctx.translate(x, y);
      if (o.angle) ctx.rotate((o.angle * Math.PI) / 180);
      ctx.scale(o.flip ? -sx : sx, sx);
      // 原點照「沒裁切的原尺寸」算（Phaser 的 displayOrigin 用 realWidth）
      const dx = -rw * ox + tx;
      const dy = -rh * oy + ty;
      ctx.drawImage(img, cx, cy, cw, ch, dx, dy, cw, ch);
      ctx.restore();
      return true;
    }
    /** 沒有任何切法（早期快照沒存 __BASE）：整張第一個來源圖 */
    function wholeImage(t) {
      const img = t.images[0];
      return img
        ? [
            0,
            0,
            0,
            img.naturalWidth,
            img.naturalHeight,
            0,
            0,
            img.naturalWidth,
            img.naturalHeight,
            0,
          ]
        : null;
    }
    function firstFrame(t) {
      for (const k in t.frames) if (k !== "__BASE") return t.frames[k];
      return t.frames.__BASE || null;
    }
    function frameSize(key, name) {
      const t = tex[key];
      const f = t && t.frames[name === undefined ? "__BASE" : String(name)];
      return f ? { w: f[7], h: f[8] } : null;
    }

    /** 點陣字（statenum_1 這些）。沒有字形資料就退回一般字。 */
    function bitmapText(key, text, x, y, opt) {
      const t = tex[key];
      const o = opt || {};
      const bf = t && t.bitmapFont;
      const s = String(text);
      if (!bf || !bf.chars) {
        plainText(s, x, y, {
          size: o.size || 12,
          align: o.ox === 0.5 ? "center" : "left",
          color: "#fff",
        });
        return;
      }
      const scale = (o.size || bf.size) / bf.size;
      let width = 0;
      for (const c of s) {
        const g = bf.chars[c.charCodeAt(0)];
        if (g) width += g.xAdvance * scale;
      }
      const base = t.frames[bf.frame || "__BASE"] || t.frames.__BASE;
      const img = t.images[base ? base[0] : 0];
      if (!img) return;
      // Phaser 的 setTint 是相乘；字形是白的，所以先畫到暫存畫布、再用 source-in 填色就一樣
      const lh = Math.ceil((bf.lineHeight || 16) * scale) + 4;
      const off = document.createElement("canvas");
      off.width = Math.ceil(width) + 4;
      off.height = lh;
      const g2 = off.getContext("2d");
      let cx = 0;
      for (const c of s) {
        const g = bf.chars[c.charCodeAt(0)];
        if (!g) continue;
        g2.drawImage(
          img,
          g.x,
          g.y,
          g.width,
          g.height,
          cx + g.xOffset * scale,
          g.yOffset * scale,
          g.width * scale,
          g.height * scale,
        );
        cx += g.xAdvance * scale;
      }
      if (o.tint) {
        g2.globalCompositeOperation = "source-in";
        g2.fillStyle = o.tint;
        g2.fillRect(0, 0, off.width, off.height);
      }
      ctx.drawImage(off, x - width * (o.ox || 0), y);
    }

    function plainText(s, x, y, o) {
      ctx.save();
      ctx.font = `${o.weight || ""} ${o.size || 14}px ${o.family || '"Source Han Serif TC", "Noto Serif CJK TC", "Noto Serif TC", serif'}`;
      ctx.textAlign = o.align || "left";
      ctx.textBaseline = o.baseline || "middle";
      if (o.stroke) {
        ctx.lineWidth = o.stroke;
        ctx.strokeStyle = "#000";
        ctx.strokeText(s, x, y);
      }
      ctx.fillStyle = o.color || "#fff";
      ctx.fillText(s, x, y);
      ctx.restore();
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────

    /** 一張行動卡／事件卡／背面，中心在 (x,y)。 */
    function card(slot, x, y, faceUp) {
      if (!slot || !slot.card || !faceUp) {
        if (!frame("ActionCardImages", "back", x, y)) placeholder(x, y, "?");
        return;
      }
      const c = slot.card;
      const angle = slot.rotated ? 180 : 0;
      if (c.type === "event") {
        if (frame("EventCardImages", "event_" + c.index, x, y, { angle })) return;
      }
      ctx.save();
      ctx.translate(x, y);
      if (angle) ctx.rotate(Math.PI);
      const a = half(c, 1);
      const b = half(c, 2);
      if (!frame("ActionCardImages", "base", 0, 0)) placeholder(0, 0, "");
      if (a) frame("ActionCardImages", SUIT_FRAME[a.suit], 0, 0);
      if (b) frame("ActionCardImages", SUIT_FRAME[b.suit], 0, 0, { angle: 180 });
      const font = {
        family: '"BradleyGratis", "Times New Roman", serif',
        size: 31,
        stroke: 3,
        align: "center",
      };
      if (a) plainText(String(a.value), -16, -26, font);
      if (b) {
        ctx.save();
        ctx.translate(16, 26);
        ctx.rotate(Math.PI);
        plainText(String(b.value), 0, 0, font);
        ctx.restore();
      }
      ctx.restore();
    }
    function placeholder(x, y, label) {
      ctx.save();
      ctx.fillStyle = "rgba(30,30,40,.9)";
      ctx.strokeStyle = "#888";
      ctx.fillRect(x - 27, y - 41, 54, 82);
      ctx.strokeRect(x - 27, y - 41, 54, 82);
      ctx.restore();
      if (label) plainText(label, x, y, { size: 14, align: "center" });
    }

    /** 官方出牌列的 x（949 的 card_submit 動畫）：置中、奇數張再右移半格。 */
    function playedX(n, i) {
      let x = 380 - 60 * Math.ceil(n / 2) + 60 * i + 30;
      if (n % 2 === 1) x += 30;
      return x;
    }

    function drawCards(st) {
      const me = st.sides[pov];
      const them = st.sides[opp];
      const live = (side) => side.cards.map((c, i) => (c ? { c, i } : null)).filter(Boolean);
      const myHand = live(me).filter((x) => !x.c.played);
      const myPlayed = live(me).filter((x) => x.c.played);
      const opHand = live(them).filter((x) => !x.c.played);
      const opPlayed = live(them).filter((x) => x.c.played);
      // 對手手牌：從右上往左疊，蓋著
      opHand.forEach((x, k) => card(x.c, 730 - 15 * k, -10, false));
      // 雙視角合併過的牌譜：對手手上當時蓋著的牌，事後補上牌面 —— 縮小、半透明畫在上方，
      // 跟「當時就看得到的」分開（官方的對手手牌只露出底邊，畫在原位看不到）
      const peeked = opHand.filter((x) => x.c.peek);
      if (peeked.length > 0) {
        peeked.forEach((x, k) => {
          ctx.save();
          ctx.globalAlpha = 0.85;
          ctx.translate(738 - 30 * k, 120);
          ctx.scale(0.5, 0.5);
          card(x.c, 0, 0, true);
          ctx.restore();
        });
      }
      opPlayed.forEach((x, k) => card(x.c, playedX(opPlayed.length, k), 130, x.c.card !== null));
      myPlayed.forEach((x, k) => card(x.c, playedX(myPlayed.length, k), 380, true));
      // 我方手牌：一頁 9 張（官方翻頁，這裡縮排擠進同一排）
      const step = myHand.length > 9 ? Math.max(28, 540 / myHand.length) : 60;
      myHand.forEach((x, k) => card(x.c, 202 + step * k, 512, true));
    }

    // ── 角色 ──────────────────────────────────────────────────────────────

    function mainChara(side) {
      const cs = side.charas || [];
      return cs.find((c) => c && c.main) || cs[0] || null;
    }

    function standOrigin(chara) {
      const chars = tables.Characters;
      const sz = frameSize(chara + "_s", chara + "_s");
      const sc = chars && chars[chara] && chars[chara].standchara;
      return sz && typeof sc === "number" ? sc / sz.w : 0.5;
    }

    function drawStand(st) {
      const d = typeof st.distance === "number" ? st.distance : 1;
      const m = mainChara(st.sides[pov]);
      const o = mainChara(st.sides[opp]);
      if (o && o.chara)
        frame(o.chara + "_s", o.chara + "_s", 472 + 104 * d, 340, {
          ox: 1 - standOrigin(o.chara),
          oy: 0.5,
          flip: true,
        });
      if (m && m.chara)
        frame(m.chara + "_s", m.chara + "_s", 288 - 104 * d, 340, {
          ox: standOrigin(m.chara),
          oy: 0.5,
        });
    }

    /**
     * 角色狀態欄（官方 chara_status＋statenum_1 點陣字）：名字、LV／ATK／DEF、右邊 HP。
     * 我方主角不畫狀態欄（官方畫在左下的大張角色卡），其餘排在 252、420；對手主角在 84。
     * ⚠ 對手還沒亮相的角色（known: false）官方顯示 LV ? ATK ? DEF ? HP ?、沒有名字 ——
     * 重播一樣，否則就把當時看不到的東西畫出來了。
     */
    function drawStatus(side, y, main, mine) {
      const cs = (side.charas || []).filter(
        (c) => c && c.card_id !== null && c.card_id !== undefined,
      );
      const others = cs.filter((c) => c !== main);
      const slots = mine
        ? others.map((c, k) => [c, [252, 420][k]])
        : [main, ...others].filter(Boolean).map((c, k) => [c, [84, 252, 420][k]]);
      // 官方 183.js 的角色狀態欄（底圖 168×32 置中）：LV／ATK／DEF 深灰點陣字在左下、HP 上限淺灰在右下，
      // 右上大數字是目前 HP（滿血白、≥一半淡黃、>0 淡紅），陣亡換第 1 格（骷髏），沒亮相蓋第 2 格＋「?」
      slots.forEach(([c, x]) => {
        if (x === undefined) return;
        const hp = c.hp ?? 0;
        const hidden = !mine && c.known === false;
        const L = x - 84;
        const T = y - 16;
        const B = y + 16;
        const R = x + 84;
        frame("chara_status", hp <= 0 ? 1 : 0, x, y);
        bitmapText("statenum_1", c.level ?? 0, L + 21, B - 9, { tint: "#4c4c4c" });
        bitmapText("statenum_1", c.atk ?? 0, L + 64, B - 9, { tint: "#4c4c4c" });
        bitmapText("statenum_1", c.def ?? 0, L + 103, B - 9, { tint: "#4c4c4c" });
        bitmapText("statenum_1", c.hp_max ?? 0, R - 8, B - 9, { ox: 0.5, tint: "#b4b4b6" });
        plainText(charaName(c.chara), L + 68, T + 11, {
          family: "font_bold, serif",
          size: 15,
          align: "center",
          color: "#4c4c4c",
        });
        if (hp > 0) {
          const max = c.hp_max || hp;
          const color = hp >= max ? "#ffffff" : hp >= max / 2 ? "#feffa2" : "#ffa1a1";
          plainText(String(hp), R - 14, T + 9, {
            family: '"BradleyGratis", serif',
            size: 28,
            align: "center",
            color,
          });
        }
        if (hidden) {
          frame("chara_status", 2, x, y);
          plainText("?", R - 17, T + 9, {
            family: '"BradleyGratis", serif',
            size: 28,
            align: "center",
          });
        }
        // 狀態異常：名稱＋剩幾回合（官方畫在階段場景裡，這裡縮在狀態欄上方）
        const states = Array.isArray(c.state) ? c.state : [];
        states.forEach((s, j) => {
          plainText(
            `${stateName(s.type)}${s.turn ? s.turn : ""}`,
            x - 70 + j * 36,
            y - (y > 340 ? 22 : -22),
            { size: 11, stroke: 3 },
          );
        });
      });
    }

    const LANG = (replay.meta && replay.meta.lang) || "tcn";

    /** 狀態名：State 表的 *_clip 開頭「[中毒]」（當時版本的文字） */
    function stateName(type) {
      const S = tables.State;
      const base = String(type || "").replace(/[0-9]+$/, "");
      const e = S && (S[type] || S[base]);
      const clip = e && e[LANG + "_clip"];
      if (typeof clip === "string" && clip.charAt(0) === "[") {
        const end = clip.indexOf("]");
        if (end > 1) return clip.slice(1, end);
      }
      return type || "?";
    }

    function charaName(chara) {
      const C = tables.Characters;
      const n = C && chara && C[chara] && C[chara]["name_" + LANG];
      return typeof n === "string" ? n : chara || "";
    }

    function featOf(id) {
      const F = tables.Feats;
      return Array.isArray(F) ? F.find((f) => f && f.id === id) || null : null;
    }

    /** 技能列（官方 skill_base）：我方 y=452、對手 y=44，名字照當時版本的 Feats 表 */
    function drawSkills(side, y, xs, hidden) {
      const m = mainChara(side);
      if (!m || !Array.isArray(m.skill)) return;
      m.skill.forEach((id, k) => {
        const x = xs[k];
        if (x === undefined) return;
        frame("skill_base", 0, x, y);
        if (hidden) return;
        const f = featOf(id);
        const name = f && f["name_" + LANG];
        // 官方是深色底上的白色粗體（2026-10-23 實機截圖對照）
        if (name)
          plainText(name, x + 4, y, { size: 15, align: "center", color: "#fff", weight: "bold" });
      });
    }

    /** 我方主角的大張角色卡（左下）：CharaCardImages 的格名＝CharaCards.filename */
    function drawMainCard(st) {
      const m = mainChara(st.sides[pov]);
      if (!m || !m.filename) return;
      const sz = frameSize("CharaCardImages", m.filename);
      if (!sz) return;
      const scale = Math.min(166 / sz.w, 236 / sz.h);
      frame("CharaCardImages", m.filename, 84, 561, { scale });
      // 官方疊在卡上的字（位置照 2026-10-23 實機截圖量）：名字、等級、下排 HP／ATK／DEF
      const num = { family: '"BradleyGratis", serif', size: 20, stroke: 3, align: "center" };
      plainText(charaName(m.chara), 91, 457, {
        family: "font_bold, serif",
        size: 15,
        align: "center",
        color: "#4c4c4c",
      });
      plainText(String(m.level ?? ""), 21, 473, num);
      plainText(String(m.hp ?? 0), 36, 669, num);
      plainText(String(m.atk ?? 0), 93, 669, num);
      plainText(String(m.def ?? 0), 151, 669, num);
    }

    function drawLife(st) {
      const m = mainChara(st.sides[pov]);
      const o = mainChara(st.sides[opp]);
      ctx.save();
      ctx.fillStyle = "#fe0000";
      if (m && m.hp_max) ctx.fillRect(0, 436, (354 * Math.max(0, m.hp)) / m.hp_max, 3);
      if (o && o.hp_max) {
        const w = (354 * Math.max(0, o.hp)) / o.hp_max;
        ctx.fillRect(760 - w, 436, w, 3);
      }
      ctx.restore();
      if (m)
        plainText(`${m.hp}/${m.hp_max}`, 6, 420, {
          family: '"BradleyGratis", serif',
          size: 26,
          stroke: 3,
        });
      if (o)
        plainText(`${o.hp}/${o.hp_max}`, 754, 420, {
          family: '"BradleyGratis", serif',
          size: 26,
          stroke: 3,
          align: "right",
        });
    }

    // ── 畫一步 ────────────────────────────────────────────────────────────

    function drawBackground(st) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      const stage = replay.meta && replay.meta.stage;
      if (stage) {
        if (!frame("bg" + stage, undefined, 0, 0, { ox: 0, oy: 0 })) {
          frame("bg" + stage + "_light", undefined, 0, 0, { ox: 0, oy: 0 });
        }
      }
      drawStand(st);
      frame("GameUIImages", "top", 0, 0, { ox: 0, oy: 0 });
      frame("GameUIImages", "bottom", 0, 680, { ox: 0, oy: 1 });
      frame("life_base", undefined, 0, 440, { ox: 0, oy: 1 });
    }

    function drawMiddle(st) {
      const d = typeof st.distance === "number" ? st.distance : null;
      if (d !== null && RANGE[d]) {
        if (!frame("range_" + RANGE[d], RANGE[d] + "-62", 380, 190)) {
          frame("range_" + RANGE[d], undefined, 380, 190);
        }
        frame("RangeLetters", RANGE[d], 380, 200);
      }
      const pf = phaseFrame(st);
      if (pf !== undefined) frame("phase_image", pf, 380, 66);
      // 回合數：官方 MainA.turn_text (700,65) BradleyGratis 32
      plainText(String(st.turn), 700, 65, {
        family: '"BradleyGratis", serif',
        size: 32,
        stroke: 3,
        align: "left",
      });
      // 牌堆
      frame("deck_sheet", "deck-32", 3, 54, { ox: 0, oy: 0 });
      plainText(String(st.deckLeft), 30, 110, {
        family: '"BradleyGratis", serif',
        size: 22,
        stroke: 3,
        align: "center",
      });
      // 攻防值
      const me = st.sides[pov];
      const them = st.sides[opp];
      const num = (v, x, y, color) =>
        v !== null &&
        v !== undefined &&
        plainText(String(v), x, y, {
          family: '"BradleyGratis", serif',
          size: 34,
          stroke: 4,
          align: "center",
          color,
        });
      if (st.phase === "AttackPhaseA") {
        num(me.attack, 240, 300, "#ffd36b");
        num(them.defense, 520, 300, "#9fd8ff");
      } else if (st.phase === "DefensePhaseA") {
        num(them.attack, 520, 300, "#ffd36b");
        num(me.defense, 240, 300, "#9fd8ff");
      }
      if (st.phase === "MovePhaseA" && (me.moveDir || them.moveDir)) {
        const dn = { front: "前進", back: "後退", stay: "待機", change: "換角" };
        if (me.moveDir)
          plainText(`${dn[me.moveDir] || me.moveDir} ${me.movePower ?? ""}`, 240, 262, {
            size: 15,
            stroke: 3,
            align: "center",
          });
        if (them.moveDir)
          plainText(`${dn[them.moveDir] || them.moveDir} ${them.movePower ?? ""}`, 520, 262, {
            size: 15,
            stroke: 3,
            align: "center",
          });
      }
      if (st.dice) drawDice(st);
    }

    function drawDice(st) {
      const d = st.dice;
      const atkSide = st.atkValue ? st.atkValue.side : null;
      const atkMine = atkSide === pov;
      const row = (arr, y, good) => {
        const n = arr.length;
        const size = n > 20 ? 10 : 14;
        const x0 = 380 - (n * (size + 2)) / 2;
        arr.forEach((v, i) => {
          ctx.save();
          ctx.fillStyle = v === 1 ? good : "rgba(255,255,255,.25)";
          ctx.fillRect(x0 + i * (size + 2), y, size, size);
          ctx.restore();
        });
      };
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fillRect(140, 222, 480, 70);
      ctx.restore();
      row(d.atkArr || [], 232, "#ffcf4a");
      row(d.defArr || [], 262, "#7fd0ff");
      plainText(`攻 ${d.atkSuc}`, 150, 239, { size: 13, stroke: 3 });
      plainText(`防 ${d.defSuc}`, 150, 269, { size: 13, stroke: 3 });
      plainText(atkMine ? "我方攻擊" : "對手攻擊", 610, 239, {
        size: 13,
        stroke: 3,
        align: "right",
      });
    }

    function drawLog(i) {
      const steps = replay.steps;
      const lines = [];
      for (let k = i; k >= 0 && lines.length < 5; k--) lines.unshift(steps[k].text);
      ctx.save();
      ctx.beginPath();
      ctx.rect(168, 560, 336, 88);
      ctx.clip();
      lines.forEach((s, k) =>
        plainText(s, 172, 570 + k * 17, {
          size: 12,
          color: k === lines.length - 1 ? "#fff" : "#bbb",
        }),
      );
      ctx.restore();
    }

    function show(i) {
      const step = replay.steps[Math.max(0, Math.min(i, replay.steps.length - 1))];
      if (!step) return;
      const st = step.state;
      drawBackground(st);
      drawMainCard(st);
      drawLife(st);
      drawSkills(st.sides[pov], 452, [242, 390, 538, 686], false);
      drawSkills(st.sides[opp], 44, [518, 370, 222, 74], mainChara(st.sides[opp])?.known === false);
      drawStatus(st.sides[pov], 664, mainChara(st.sides[pov]), true);
      drawStatus(st.sides[opp], 16, mainChara(st.sides[opp]), false);
      drawMiddle(st);
      drawCards(st);
      drawLog(replay.steps.indexOf(step));
    }

    return { show, size: { w: W, h: H } };
  }

  /** 把快照的貼圖清單載成圖片。`urlOf(sha)` 給圖檔網址。 */
  async function loadTextures(manifest, urlOf) {
    const out = {};
    const cache = new Map();
    const load = (sha) => {
      if (!sha) return Promise.resolve(null);
      if (!cache.has(sha)) {
        cache.set(
          sha,
          new Promise((ok) => {
            const img = new Image();
            img.onload = () => ok(img);
            img.onerror = () => ok(null);
            img.src = urlOf(sha);
          }),
        );
      }
      return cache.get(sha);
    };
    await Promise.all(
      Object.entries(manifest).map(async ([key, entry]) => {
        const images = await Promise.all(entry.sources.map(load));
        out[key] = { images, frames: entry.frames || {}, bitmapFont: entry.bitmapFont || null };
      }),
    );
    return out;
  }

  window.KifuViewer = { create, loadTextures };
})();
