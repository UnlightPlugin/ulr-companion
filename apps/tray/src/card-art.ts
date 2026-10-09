/**
 * 卡面替換（MOD）的資料夾
 * ========================
 * 玩家把 PNG 丟進
 *
 *     %APPDATA%\ulr-companion\mods\cards\
 *
 * 插件就把它換進遊戲的卡面圖集（`@ulr/cdp-adapter` 的 patch-card-art.ts）。
 * 這支負責「資料夾裡有什麼」→「要送去頁面的清單」那一段：檔名對到哪一格、
 * 尺寸對不對、哪些檔要跳過。**不碰遊戲**，純函式，可以離線測。
 *
 * ## 檔名怎麼對
 *
 * 兩種都收：
 *
 * - 圖集的格子鍵：`cc034_r01.png`（史塔夏 R1）、`cc034_01.png`（L1）
 * - 角色中文名 + 格位：`史塔夏_R1.png`、`史塔夏 L3.png`（名字照遊戲裡的寫法）
 *
 * 中文名要靠名字表（`cc034` → `史塔夏`，第一次接上遊戲時從客戶端讀、存在
 * `mods\card-names.json`），沒有時只認格子鍵。對不到的檔留在清單上、標
 * 「對不到」，不會送去頁面。
 *
 * 放 `APP_DIR` 而不是 `userData`：卡面是玩家的美術，不分帳號、不分實例。
 * 子資料夾一律不看（`空框\` 放的是插件內建的底稿），檔名開頭 `_` 的也跳過。
 *
 * ## 尺寸
 *
 * 一格 168×240。等比例放大的也收（頁面會縮），比例不對就拒絕 —— 硬拉會變形，
 * 玩家會以為是插件畫壞。PNG 的尺寸從檔頭（IHDR）讀，不用解碼整張。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CardArtEntry } from "@ulr/cdp-adapter";
import { CARD_FRAME_HEIGHT, CARD_FRAME_WIDTH } from "@ulr/cdp-adapter";

/** 單一檔案的上限。卡面本來只有 168×240，超過這個一定是放錯東西。 */
export const MAX_CARD_ART_BYTES = 4 * 1024 * 1024;

/** 空框放這個子資料夾（相對 mods\cards）。 */
export const CARD_ART_BLANKS_DIR = "空框";

/**
 * 內建空框的兩種尺寸，也是 `空框\` 底下的子資料夾名。
 *
 * 168×240 是從 631 張官方卡面統計出來的原寸（`card-art-extract.ts`）；
 * 336×480 是拿原寸用 AI 放大的（`scripts/upscale-card-frames.py`），給想畫
 * 大圖的人用 —— 插件照樣縮回 168×240 換進遊戲。
 */
export const CARD_FRAME_SIZES = ["168x240", "336x480"] as const;

/** `空框\` 裡記內建那一份是哪一版的檔。檔名開頭 `.`，玩家打開資料夾不太會去動。 */
const BLANKS_STAMP = ".bundle";

/** 角色代號 → 中文名。 */
export type CardNames = Record<string, string>;

/** 資料夾裡的一個檔案在畫面上長什麼樣。 */
export interface CardArtFile {
  file: string;
  /** 對到的格子鍵；對不到是 null，`problem` 說為什麼。 */
  frame: string | null;
  /** 對到的卡怎麼稱呼（「史塔夏 R1」）。沒名字表就是格子鍵本身。 */
  label: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  /** 這個檔為什麼不會送去頁面。null = 會送。 */
  problem: string | null;
}

export interface CardArtScan {
  files: CardArtFile[];
  /** 真的要送去頁面的那些。 */
  entries: CardArtEntry[];
}

const KEY_RE = /^(cc\d{3})_(r?)0([1-5])$/i;
const NAME_RE = /^(.+?)[\s_－-]*([LR])\s*([1-5])$/i;

/** 讀 PNG 檔頭的寬高。不是 PNG 回 null。 */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function slotLabel(rare: boolean, level: string): string {
  return `${rare ? "R" : "L"}${level}`;
}

/**
 * 檔名（不含副檔名）→ 格子鍵。對不到回 null。
 *
 * 格子鍵的形狀是圖集自己的：L 卡 `cc034_01`、R 卡 `cc034_r01`。
 */
export function resolveCardFrame(
  stem: string,
  names: CardNames | null,
): { frame: string; label: string } | null {
  const trimmed = stem.trim();
  const key = KEY_RE.exec(trimmed);
  if (key !== null) {
    const cc = (key[1] ?? "").toLowerCase();
    const rare = key[2] !== "";
    const level = key[3] ?? "";
    const frame = `${cc}_${rare ? "r" : ""}0${level}`;
    const name = names?.[cc];
    return { frame, label: name === undefined ? frame : `${name} ${slotLabel(rare, level)}` };
  }
  if (names === null) return null;
  const m = NAME_RE.exec(trimmed);
  if (m === null) return null;
  const name = (m[1] ?? "").trim();
  const rare = (m[2] ?? "").toUpperCase() === "R";
  const level = m[3] ?? "";
  const cc = Object.keys(names).find((k) => names[k] === name);
  if (cc === undefined) return null;
  return { frame: `${cc}_${rare ? "r" : ""}0${level}`, label: `${name} ${slotLabel(rare, level)}` };
}

/** 檔案系統的部分抽出來，測試可以餵假的。 */
export interface CardArtFs {
  list(dir: string): string[];
  read(dir: string, file: string): Buffer;
  isFile(dir: string, file: string): boolean;
}

const realFs: CardArtFs = {
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: (dir, file) => readFileSync(join(dir, file)),
  isFile: (dir, file) => {
    try {
      return statSync(join(dir, file)).isFile();
    } catch {
      return false;
    }
  },
};

export function scanCardArtDir(
  dir: string,
  names: CardNames | null,
  fs: CardArtFs = realFs,
): CardArtScan {
  const files: CardArtFile[] = [];
  const entries: CardArtEntry[] = [];
  const taken = new Map<string, string>();
  const list = fs
    .list(dir)
    .filter((f) => /\.png$/i.test(f) && !f.startsWith("_") && fs.isFile(dir, f))
    .sort((a, b) => a.localeCompare(b, "zh-Hant"));
  for (const file of list) {
    const stem = file.replace(/\.png$/i, "");
    const hit = resolveCardFrame(stem, names);
    const row: CardArtFile = {
      file,
      frame: hit?.frame ?? null,
      label: hit?.label ?? null,
      width: null,
      height: null,
      bytes: 0,
      problem: null,
    };
    files.push(row);
    let buf: Buffer;
    try {
      buf = fs.read(dir, file);
    } catch {
      row.problem = "讀不到這個檔";
      continue;
    }
    row.bytes = buf.length;
    const size = pngSize(buf);
    if (size === null) {
      row.problem = "不是 PNG";
      continue;
    }
    row.width = size.width;
    row.height = size.height;
    if (hit === null) {
      row.problem =
        names === null
          ? "對不到卡：檔名要用格子鍵（cc034_r01）；中文名要等接上遊戲讀到名字表"
          : "對不到卡：檔名要是「角色名_R1」或格子鍵（cc034_r01）";
      continue;
    }
    if (buf.length > MAX_CARD_ART_BYTES) {
      row.problem = `太大（${(buf.length / 1024 / 1024).toFixed(1)} MB）；卡面只有 168×240`;
      continue;
    }
    if (
      Math.abs(size.width * CARD_FRAME_HEIGHT - size.height * CARD_FRAME_WIDTH) >
      0.015 * size.width * CARD_FRAME_HEIGHT
    ) {
      row.problem = `比例不對：要 ${CARD_FRAME_WIDTH}×${CARD_FRAME_HEIGHT}（或等比例放大）`;
      continue;
    }
    const dup = taken.get(hit.frame);
    if (dup !== undefined) {
      row.problem = `跟「${dup}」是同一張卡，用了那一張`;
      continue;
    }
    taken.set(hit.frame, file);
    entries.push({ frame: hit.frame, dataUrl: `data:image/png;base64,${buf.toString("base64")}` });
  }
  return { files, entries };
}

export interface BlanksInstall {
  /** 這次寫進去的檔數。 */
  written: number;
  /** 內建的總檔數。0 = 找不到內建那一份（開發時沒 build 過 assets）。 */
  bundled: number;
}

/**
 * **把打包進插件的空框放到玩家的 `mods\cards\空框\`。**
 *
 * 內建那一份住在 app.asar 裡，檔案總管打不開、繪圖軟體也讀不到，所以得複製出來。
 *
 * - 少的檔一律補上（玩家刪了也會回來 —— 它是底稿，不是作品）
 * - 內建那一份換版了（`.bundle` 裡的指紋對不上）→ 全部覆寫，拿到新的框
 * - 指紋一樣就不覆寫已經在的檔：玩家就算直接在底稿上改，也不會被每次開機洗掉
 */
export function installBundledBlanks(bundleDir: string, blanksDir: string): BlanksInstall {
  const files: { size: string; name: string; data: Buffer }[] = [];
  for (const size of CARD_FRAME_SIZES) {
    let names: string[];
    try {
      names = readdirSync(join(bundleDir, size)).filter((f) => /\.png$/i.test(f));
    } catch {
      continue;
    }
    for (const name of names.sort())
      files.push({ size, name, data: readFileSync(join(bundleDir, size, name)) });
  }
  if (files.length === 0) return { written: 0, bundled: 0 };

  const hash = createHash("sha1");
  for (const f of files) hash.update(`${f.size}/${f.name}\0`).update(f.data);
  const stamp = hash.digest("hex");
  let installed: string | null = null;
  try {
    installed = readFileSync(join(blanksDir, BLANKS_STAMP), "utf8").trim();
  } catch {
    // 第一次裝
  }
  const upgrade = installed !== stamp;

  let written = 0;
  for (const f of files) {
    const dir = join(blanksDir, f.size);
    const path = join(dir, f.name);
    if (!upgrade && existsSync(path)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, f.data);
    written++;
  }
  if (upgrade) writeFileSync(join(blanksDir, BLANKS_STAMP), `${stamp}\n`, "utf8");
  return { written, bundled: files.length };
}

/** `mods\cards\` 裡記內建 MOD 放過哪些檔、放的是哪一版。 */
const DEFAULT_MODS_STAMP = ".defaults.json";

export interface DefaultModsInstall {
  /** 這次寫進去的檔數。 */
  written: number;
  /** 內建的總檔數。0 = 找不到內建那一份。 */
  bundled: number;
}

/**
 * **把打包進插件的預設卡面 MOD 放到玩家的 `mods\cards\`。**
 *
 * 跟空框不一樣，這些是「作品」不是底稿，所以規則反過來：
 *
 * - 沒放過的檔才放（`.defaults.json` 記每個檔放過的那一版指紋）
 * - **玩家刪掉的不補回來** —— 刪檔就是玩家關掉這張 MOD 的方法
 * - 玩家沒動過、內建那一份換版了 → 換成新版
 * - 玩家改過、或本來就有同名的自己的檔 → 不碰
 */
export function installDefaultMods(bundleDir: string, cardsDir: string): DefaultModsInstall {
  let names: string[];
  try {
    names = readdirSync(bundleDir).filter((f) => /\.png$/i.test(f));
  } catch {
    return { written: 0, bundled: 0 };
  }
  if (names.length === 0) return { written: 0, bundled: 0 };

  const stampPath = join(cardsDir, DEFAULT_MODS_STAMP);
  let placed: Record<string, string> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(stampPath, "utf8"));
    if (raw !== null && typeof raw === "object") placed = raw as Record<string, string>;
  } catch {
    // 第一次裝，或檔壞了 —— 當作都沒放過
  }
  const sha1 = (b: Buffer): string => createHash("sha1").update(b).digest("hex");

  let written = 0;
  let changed = false;
  for (const name of names.sort()) {
    const data = readFileSync(join(bundleDir, name));
    const want = sha1(data);
    const path = join(cardsDir, name);
    const before = placed[name];
    if (!existsSync(path)) {
      if (before !== undefined) continue; // 玩家刪掉的
    } else {
      const have = sha1(readFileSync(path));
      if (have === want) {
        if (before !== want) {
          placed[name] = want;
          changed = true;
        }
        continue;
      }
      if (before !== have) continue; // 玩家自己的或改過的
    }
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(path, data);
    placed[name] = want;
    written++;
    changed = true;
  }
  if (changed) writeFileSync(stampPath, `${JSON.stringify(placed, null, 2)}\n`, "utf8");
  return { written, bundled: names.length };
}

/** `空框\` 底下每種尺寸各有幾張。 */
export function countBlanks(blanksDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const size of CARD_FRAME_SIZES) {
    try {
      out[size] = readdirSync(join(blanksDir, size)).filter((f) => /\.png$/i.test(f)).length;
    } catch {
      out[size] = 0;
    }
  }
  return out;
}

/** 資料夾不在就建。回傳它的路徑。 */
export function ensureCardArtDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 讀存起來的名字表。沒有、壞掉回 null。 */
export function readCardNames(path: string): CardNames | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const out: CardNames = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^cc\d{3}$/.test(k) && typeof v === "string" && v !== "") out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
