/**
 * 牌譜落地（Node）
 * ================
 *
 *     <root>/kifu/<開始時間>_<模式>_<座位>_<key>.jsonl     一場一份，格式見 format.ts
 *     <root>/store/tables/<sha256>.json                  資料表（當時的 JSON 原文）
 *     <root>/store/blobs/<sha256>.<副檔名>               圖檔原檔
 *     <root>/store/textures/<sha256>.json                貼圖快照（來源圖雜湊＋切法）
 *
 * 托盤的根目錄是 `~/.ulr-companion/battle/`（.gitignore 擋 `**\/battle/` 的理由見
 * docs/battle-features.md：牌譜不進版控）。
 *
 * 寫入一律同步、追加：戰鬥中一秒一行，量很小；同步寫的好處是托盤當掉時已經回報的都在磁碟上。
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { KifuEndReport, KifuEventsReport, KifuStartReport } from "@ulr/cdp-adapter";
import {
  KIFU_FILE_FORMAT,
  kifuFileName,
  parseKifuText,
  type KifuEndLine,
  type KifuEventsLine,
  type KifuOrphanLine,
  type KifuRecord,
  type KifuSnapLine,
  type KifuStartLine,
} from "./format.js";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** engine 只認這個介面（測試換成記憶體版）。 */
export interface KifuStore {
  begin(report: KifuStartReport): void;
  append(report: KifuEventsReport): void;
  end(report: KifuEndReport): void;
  writeSnapshot(key: string, snap: KifuSnapLine): void;
  hasTable(sha: string): boolean;
  putTable(sha: string, text: string): void;
  readTable(sha: string): string | null;
  hasBlob(sha: string): boolean;
  putBlob(sha: string, ext: string, bytes: Uint8Array): void;
  hasTexture(sha: string): boolean;
  putTexture(sha: string, json: string): void;
  /** 某場的檔案路徑（只有落地在檔案的存放區有） */
  pathOf?(key: string): string | null;
}

const SHA_RE = /^[0-9a-f]{64}$/;

function ensureSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error(`不是 SHA-256：${sha.slice(0, 80)}`);
  return sha;
}

export class KifuFileStore implements KifuStore {
  readonly root: string;
  readonly kifuDir: string;
  readonly tableDir: string;
  readonly blobDir: string;
  readonly textureDir: string;
  /** key → 檔案路徑（這次開機錄的） */
  #files = new Map<string, string>();
  /** 已經有的 blob（sha → 檔名），第一次問才掃目錄 */
  #blobs: Map<string, string> | null = null;

  constructor(root: string) {
    this.root = root;
    this.kifuDir = join(root, "kifu");
    this.tableDir = join(root, "store", "tables");
    this.blobDir = join(root, "store", "blobs");
    this.textureDir = join(root, "store", "textures");
  }

  #write(path: string, line: object): void {
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  }

  #fileFor(key: string): string {
    const known = this.#files.get(key);
    if (known !== undefined) return known;
    // 開場那行沒收到（托盤在戰鬥中途才起來、或重開過）—— 照樣收，第一行標成孤兒
    mkdirSync(this.kifuDir, { recursive: true });
    const path = join(this.kifuDir, kifuFileName(key, Date.now(), null, null));
    this.#files.set(key, path);
    const orphan: KifuOrphanLine = { t: "orphan", key, at: Date.now() };
    this.#write(path, orphan);
    return path;
  }

  begin(report: KifuStartReport): void {
    mkdirSync(this.kifuDir, { recursive: true });
    const path = join(
      this.kifuDir,
      kifuFileName(report.key, report.startedAt, report.meta.rule, report.meta.side),
    );
    this.#files.set(report.key, path);
    const line: KifuStartLine = {
      t: "start",
      format: KIFU_FILE_FORMAT,
      key: report.key,
      startedAt: report.startedAt,
      meta: report.meta,
    };
    this.#write(path, line);
  }

  append(report: KifuEventsReport): void {
    const line: KifuEventsLine = { t: "ev", seq: report.seq, ev: report.events };
    this.#write(this.#fileFor(report.key), line);
  }

  end(report: KifuEndReport): void {
    const { type: _type, key, ...rest } = report;
    const line: KifuEndLine = { t: "end", ...rest };
    this.#write(this.#fileFor(key), line);
  }

  writeSnapshot(key: string, snap: KifuSnapLine): void {
    this.#write(this.#fileFor(key), snap);
  }

  /** 這次開機錄過的某場的檔案路徑。 */
  pathOf(key: string): string | null {
    return this.#files.get(key) ?? null;
  }

  // ── 內容定址的共用區 ──────────────────────────────────────────────────

  #atomicWrite(dir: string, name: string, data: string | Uint8Array): void {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    if (existsSync(path)) return;
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  hasTable(sha: string): boolean {
    return existsSync(join(this.tableDir, `${ensureSha(sha)}.json`));
  }

  putTable(sha: string, text: string): void {
    this.#atomicWrite(this.tableDir, `${ensureSha(sha)}.json`, text);
  }

  readTable(sha: string): string | null {
    try {
      return readFileSync(join(this.tableDir, `${ensureSha(sha)}.json`), "utf8");
    } catch {
      return null;
    }
  }

  #blobIndex(): Map<string, string> {
    if (this.#blobs !== null) return this.#blobs;
    const m = new Map<string, string>();
    try {
      for (const f of readdirSync(this.blobDir)) {
        const sha = f.slice(0, 64);
        if (SHA_RE.test(sha) && !f.includes(".tmp-")) m.set(sha, f);
      }
    } catch {
      // 還沒有這個資料夾
    }
    this.#blobs = m;
    return m;
  }

  hasBlob(sha: string): boolean {
    return this.#blobIndex().has(ensureSha(sha));
  }

  putBlob(sha: string, ext: string, bytes: Uint8Array): void {
    const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
    const name = `${ensureSha(sha)}.${safeExt}`;
    this.#atomicWrite(this.blobDir, name, bytes);
    this.#blobIndex().set(sha, name);
  }

  /** blob 的檔案路徑（播放器拿來載圖）。沒有回 null。 */
  blobPath(sha: string): string | null {
    const name = this.#blobIndex().get(sha);
    return name === undefined ? null : join(this.blobDir, name);
  }

  hasTexture(sha: string): boolean {
    return existsSync(join(this.textureDir, `${ensureSha(sha)}.json`));
  }

  putTexture(sha: string, json: string): void {
    this.#atomicWrite(this.textureDir, `${ensureSha(sha)}.json`, json);
  }

  readTexture(sha: string): string | null {
    try {
      return readFileSync(join(this.textureDir, `${ensureSha(sha)}.json`), "utf8");
    } catch {
      return null;
    }
  }

  // ── 讀 ─────────────────────────────────────────────────────────────

  /** 所有牌譜檔（新的在前）。 */
  listFiles(): string[] {
    try {
      return readdirSync(this.kifuDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  readKifu(fileName: string): KifuRecord {
    const text = readFileSync(join(this.kifuDir, fileName), "utf8");
    return parseKifuText(text, fileName);
  }
}
