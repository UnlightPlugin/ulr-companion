/**
 * 首頁立繪（DeckLibrary.lobbyStand）
 * ==================================
 * 玩家 2026-10-02：「Library 可以自訂最愛，希望可以標更多最愛角色，讓首頁能出現
 * 更多立繪。每個立繪圖片都能縮放、轉角度」。2026-10-03 再加：「最愛角色群組，每次
 * 進入大廳時隨機使用其中一套，每一套可以用多個登場角色，可以新增刪減群組」。
 *
 * 官方的最愛角色是伺服器上**單一個** `player.chara_favorite`。玩家說官方那隻固定
 * 不動、在首頁藏起來就好（2026-10-03）—— 所以套組只有插件知道，存在牌組庫裡、
 * 跟最愛卡片一樣上雲：
 *
 * ```
 *   sets    [ { charas: ["cc063", "cc005", …],      這一套登場的角色，照加入順序
 *               layout: { cc063: { x, y, scale, angle, flip, z }, … } },  這一套的擺法
 *             … ]                                    每次進首頁隨機挑一套
 *   ui      { duel: { x, y, scale, hidden }, … }    大廳元件的位移／縮放／隱藏，所有套共用
 *                                                    （玩家選的，2026-10-03）
 * ```
 *
 * 整份一個時間戳、較新的整份贏（理由同 FavoriteCards：玩家一次只在一台電腦上動）。
 * 擺法不跟著角色刪：取消最愛再加回來，擺法還在。
 */

import type { DeckLibrary } from "./types.js";

/** 一張立繪在首頁的擺法。座標是遊戲畫布（760×680）上立繪中心的位置。 */
export interface StandLayout {
  x: number;
  y: number;
  /** 1 = 原尺寸。 */
  scale: number;
  /** 度，順時針為正。 */
  angle: number;
  /** 左右翻轉。 */
  flip: boolean;
  /** 疊放順序，大的在上面。 */
  z: number;
}

/**
 * 一組大廳元件的改法。`(x, y)` 是**相對官方位置的位移**（官方哪天挪了按鈕，
 * 位移照樣疊上去），縮放繞那組元件官方外框的中心。
 */
export interface UiLayout {
  x: number;
  y: number;
  scale: number;
  hidden: boolean;
}

/** 一套登場角色。 */
export interface StandSet {
  /** 角色鍵（`cc001`…），照加入順序。 */
  charas: string[];
  layout: Record<string, StandLayout>;
}

export interface LobbyStand {
  /** 至少一套（空的也算一套）。 */
  sets: StandSet[];
  /** 組名（`duel`、`ranking`、`avatar`…，名單在 patch-lobby-stand）→ 改法。沒改的不存。 */
  ui: Record<string, UiLayout>;
  /** ISO 8601。整份最後一次改動的時間。 */
  updatedAt: string;
}

/**
 * 一套最多標幾個。每張是一份自己的貼圖（裁過透明邊約 400×450），首頁進場時一次載完，
 * 不設限的話標滿 68 個角色每次回首頁都要抓 68 張圖。
 */
export const LOBBY_STAND_MAX = 20;

/** 最多幾套。 */
export const LOBBY_STAND_SETS_MAX = 10;

const SCALE_MIN = 0.2;
const SCALE_MAX = 3;
/** 中心最多拖出畫面多遠（再遠就找不回來了）。 */
const POS_MIN = -400;
const POS_MAX = 1160;

const UI_SCALE_MIN = 0.3;
const UI_SCALE_MAX = 2;
/** 位移上限：整個畫布寬（760×680）再多一點，拖再遠也只是看不到。 */
const UI_OFFSET_MAX = 800;

/** 大廳元件組名：小寫英文。名單由頁面那邊定，這裡只擋怪值。 */
export function isUiGroupKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2,16}$/.test(value);
}

/** 收一組大廳元件的改法。**容錯**同 {@link parseStandLayout}。 */
export function parseUiLayout(raw: unknown): UiLayout | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const x = num(r.x);
  const y = num(r.y);
  const scale = num(r.scale);
  if (x === null || y === null || scale === null) return null;
  return {
    x: Math.round(clamp(x, -UI_OFFSET_MAX, UI_OFFSET_MAX)),
    y: Math.round(clamp(y, -UI_OFFSET_MAX, UI_OFFSET_MAX)),
    scale: Math.round(clamp(scale, UI_SCALE_MIN, UI_SCALE_MAX) * 1000) / 1000,
    hidden: r.hidden === true,
  };
}

function parseUiMap(raw: unknown): Record<string, UiLayout> {
  const out: Record<string, UiLayout> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw).sort()) {
    if (!isUiGroupKey(key)) continue;
    const one = parseUiLayout((raw as Record<string, unknown>)[key]);
    // 跟官方一模一樣的不存（存了也只是讓「有沒有變」多一筆雜訊）
    if (one !== null && (one.x !== 0 || one.y !== 0 || one.scale !== 1 || one.hidden)) {
      out[key] = one;
    }
  }
  return out;
}

/** 角色鍵：`cc` 加三位數。 */
export function isCharaKey(value: unknown): value is string {
  return typeof value === "string" && /^cc\d{3}$/.test(value);
}

/**
 * 收一筆擺法。**容錯**：從網路與頁面上收來的，怪值夾回範圍、壞掉的整筆丟掉。
 */
export function parseStandLayout(raw: unknown): StandLayout | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const x = num(r.x);
  const y = num(r.y);
  const scale = num(r.scale);
  const angle = num(r.angle);
  if (x === null || y === null || scale === null || angle === null) return null;
  const z = num(r.z) ?? 0;
  return {
    x: Math.round(clamp(x, POS_MIN, POS_MAX)),
    y: Math.round(clamp(y, POS_MIN, POS_MAX)),
    scale: Math.round(clamp(scale, SCALE_MIN, SCALE_MAX) * 1000) / 1000,
    // 夾進 (-180, 180]，同一個角度永遠是同一個數字（存檔比對靠字串）
    angle: Math.round(normalizeAngle(angle) * 10) / 10,
    flip: r.flip === true,
    z: Math.round(z),
  };
}

/** 收一套。重複與怪值丟掉，超過 {@link LOBBY_STAND_MAX} 的不收；壞掉的擺法整筆丟。 */
export function parseStandSet(raw: unknown): StandSet {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const charas: string[] = [];
  if (Array.isArray(r.charas)) {
    for (const c of r.charas) {
      if (isCharaKey(c) && !charas.includes(c) && charas.length < LOBBY_STAND_MAX) charas.push(c);
    }
  }
  const layout: Record<string, StandLayout> = {};
  if (typeof r.layout === "object" && r.layout !== null && !Array.isArray(r.layout)) {
    for (const key of Object.keys(r.layout).sort()) {
      if (!isCharaKey(key)) continue;
      const one = parseStandLayout((r.layout as Record<string, unknown>)[key]);
      if (one !== null) layout[key] = one;
    }
  }
  return { charas, layout };
}

function parseSets(raw: unknown): StandSet[] {
  const sets = Array.isArray(raw)
    ? raw.slice(0, LOBBY_STAND_SETS_MAX).map((s) => parseStandSet(s))
    : [];
  return sets.length > 0 ? sets : [{ charas: [], layout: {} }];
}

/**
 * 收整份。沒有 `updatedAt` → 當沒設過。
 * 開發中（還沒發版）的格式是單一套的 `charas`／`layout`，收成第一套。
 */
export function parseLobbyStand(raw: unknown): LobbyStand | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.updatedAt !== "string") return null;
  const sets = Array.isArray(r.sets) ? parseSets(r.sets) : [parseStandSet(r)];
  return { sets, ui: parseUiMap(r.ui), updatedAt: r.updatedAt };
}

/** 沒設過時給一套空的（`updatedAt` 空字串，任何一份設過的都比它新）。 */
export function lobbyStand(library: DeckLibrary): LobbyStand {
  return copyLobbyStand(
    library.lobbyStand ?? { sets: [{ charas: [], layout: {} }], ui: {}, updatedAt: "" },
  );
}

function copySet(s: StandSet): StandSet {
  const layout: Record<string, StandLayout> = {};
  for (const key of Object.keys(s.layout).sort()) layout[key] = { ...s.layout[key]! };
  return { charas: [...s.charas], layout };
}

export function copyLobbyStand(s: LobbyStand): LobbyStand {
  const ui: Record<string, UiLayout> = {};
  for (const key of Object.keys(s.ui).sort()) ui[key] = { ...s.ui[key]! };
  return { sets: s.sets.map(copySet), ui, updatedAt: s.updatedAt };
}

/**
 * 換掉全部套組（Library 點愛心、首頁編輯模式新增／刪除套組或按 OK 都是整份送來）。
 * 怪值照 {@link parseStandSet} 丟掉；一套都沒有就留一套空的。沒變就回同一個物件
 * （不動時間戳 —— 一動雲端就推）。
 */
export function setLobbyStandSets(
  library: DeckLibrary,
  sets: readonly StandSet[],
  now: Date = new Date(),
): DeckLibrary {
  const cur = lobbyStand(library);
  const next = parseSets(sets);
  if (JSON.stringify(next) === JSON.stringify(cur.sets)) return library;
  return {
    ...library,
    lobbyStand: { ...cur, sets: next, updatedAt: now.toISOString() },
  };
}

/**
 * 存大廳元件的改法。**整份換掉**：OK 送的是全部改過的組，沒列到的就是改回官方
 * 原樣了。沒變就回同一個物件。
 */
export function setLobbyStandUi(
  library: DeckLibrary,
  ui: Readonly<Record<string, UiLayout>>,
  now: Date = new Date(),
): DeckLibrary {
  const cur = lobbyStand(library);
  const next = parseUiMap(ui);
  if (JSON.stringify(next) === JSON.stringify(cur.ui)) return library;
  return {
    ...library,
    lobbyStand: { ...cur, ui: next, updatedAt: now.toISOString() },
  };
}

/** 兩邊取較新的一份；只有一邊有就是那一邊，平手本地贏。 */
export function newerLobbyStand(
  local: LobbyStand | undefined,
  remote: LobbyStand | undefined,
): LobbyStand | undefined {
  if (remote === undefined) return local;
  if (local === undefined || remote.updatedAt > local.updatedAt) return copyLobbyStand(remote);
  return local;
}

/** 存檔用：key 順序固定（雲端比對「有沒有變」靠字串）。 */
export function serializeLobbyStand(s: LobbyStand): unknown {
  const sets = s.sets.map((set) => {
    const layout: Record<string, unknown> = {};
    for (const key of Object.keys(set.layout).sort()) {
      const l = set.layout[key]!;
      layout[key] = { x: l.x, y: l.y, scale: l.scale, angle: l.angle, flip: l.flip, z: l.z };
    }
    return { charas: set.charas, layout };
  });
  const ui: Record<string, unknown> = {};
  for (const key of Object.keys(s.ui).sort()) {
    const u = s.ui[key]!;
    ui[key] = { x: u.x, y: u.y, scale: u.scale, hidden: u.hidden };
  }
  return { sets, ui, updatedAt: s.updatedAt };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function normalizeAngle(a: number): number {
  let d = a % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}
