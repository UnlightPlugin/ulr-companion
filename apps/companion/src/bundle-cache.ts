/**
 * 記住這個遊戲版本的 bundle 檔名
 * ================================
 * webpack 的 content hash 每次改版都會變，所以「免 Steam 開遊戲」需要一份
 * 最新的檔名清單。來源是玩家自己跑著的客戶端（`adapter.discoverBundles()`），
 * 這裡只負責把它存起來、讀回來。
 *
 * 放在家目錄而不是專案裡：這是**這台機器上這個遊戲版本**的狀態，不是專案的
 * 一部分，不該被 commit，也不該因為換工作目錄就找不到。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GameBundles } from "@ulr/cdp-adapter";
import { parseDiscoveredBundles } from "@ulr/cdp-adapter";

export const CACHE_PATH = join(homedir(), ".ulr-companion", "bundles.json");

export interface BundleCache {
  bundles: GameBundles;
  /** ISO 8601。用來在 CLI 上提醒「這份是多久以前讀的」。 */
  discoveredAt: string;
}

export class NoBundleCacheError extends Error {
  override readonly name = "NoBundleCacheError";
  constructor() {
    super(
      `還沒有 bundle 檔名快取（${CACHE_PATH}）。\n` +
        "  先從 Steam 正常開一次遊戲，然後跑：companion web --refresh",
    );
  }
}

export function readBundleCache(): BundleCache {
  let raw: string;
  try {
    raw = readFileSync(CACHE_PATH, "utf8");
  } catch {
    throw new NoBundleCacheError();
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new NoBundleCacheError();
  }
  const { bundles, discoveredAt } = parsed as { bundles?: unknown; discoveredAt?: unknown };

  return {
    // 快取是檔案，可能被手動改壞。一樣走 boot-shell 的驗證，別讓壞資料
    // 一路傳到注入的腳本裡。
    bundles: parseDiscoveredBundles(bundles),
    discoveredAt: typeof discoveredAt === "string" ? discoveredAt : "(不明)",
  };
}

export function writeBundleCache(bundles: GameBundles): BundleCache {
  const cache: BundleCache = {
    bundles: parseDiscoveredBundles(bundles),
    discoveredAt: new Date().toISOString(),
  };
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
  return cache;
}
