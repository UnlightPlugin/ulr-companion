/**
 * 牌譜錄製（Node 這一半）
 * ======================
 * 頁面錄製器（cdp-adapter 的 patch-kifu）送三種回報，這裡把它們交給存放區（`@ulr/kifu`），
 * 一場結束之後排隊補版本快照。
 *
 * 快照排成一條佇列一場一場來：連打的時候上一場的快照還沒做完，下一場就結束了 ——
 * 兩場同時對頁面要檔，第二場就看不到第一場剛存好的、同一張圖會搬兩次。
 *
 * 失敗一律只寫記錄：牌譜本體（事件）在戰鬥中就已經落地了，快照沒做成只是那場重播時
 * 少了當時的美術（同版本的其他場存了的話還是看得到）。
 */

import type { CdpAdapter, KifuMeta, KifuReport } from "@ulr/cdp-adapter";
import { KifuSnapshotCache, snapshotMatch, type KifuPage, type KifuStore } from "@ulr/kifu";

/** 模式代號 → 記錄檔裡的說法 */
const RULE_NAMES: Record<string, string> = {
  duel: "對戰",
  ranked: "排名戰",
  quest: "任務",
  raid: "渦",
  event: "活動",
};

export interface KifuSaved {
  key: string;
  /** 存放區裡的檔案（`KifuFileStore` 才有） */
  path: string | null;
  meta: KifuMeta;
  events: number;
  reason: string;
}

export interface KifuRecorderOptions {
  store: KifuStore;
  log: (line: string) => void;
  /** 一場存好（含快照）之後叫。托盤拿來更新清單。 */
  onSaved?: (saved: KifuSaved) => void;
}

/** 用 adapter 實作快照要的四件事。 */
export function kifuPageOf(adapter: CdpAdapter): KifuPage {
  return {
    readTable: (name) => adapter.kifuReadTable(name),
    textureInfo: (keys, used) => adapter.kifuTextureInfo(keys, used),
    hashUrls: (urls) => adapter.kifuHashUrls(urls),
    readUrl: async (url) => {
      const b = await adapter.kifuReadUrl(url);
      return b === null ? null : new Uint8Array(b);
    },
    fontFiles: () => adapter.kifuFontFiles(),
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class KifuRecorder {
  #opts: KifuRecorderOptions;
  #metas = new Map<string, KifuMeta>();
  #counts = new Map<string, number>();
  #cache = new KifuSnapshotCache();
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: KifuRecorderOptions) {
    this.#opts = opts;
  }

  /** 換了一個頁面（重連、重載）：美術網域換了，網址快取作廢。 */
  resetSession(): void {
    this.#cache = new KifuSnapshotCache();
  }

  /** 等排著的快照都做完（測試與關閉用）。 */
  idle(): Promise<void> {
    return this.#queue;
  }

  /**
   * 收一則頁面回報。`page` 是結束時拿來補快照的；給 null 就只存事件、不補快照
   * （例如已經斷線）。
   */
  handle(report: KifuReport, page: KifuPage | null): void {
    const { store, log } = this.#opts;
    try {
      if (report.type === "kifu-start") {
        this.#metas.set(report.key, report.meta);
        this.#counts.set(report.key, 0);
        store.begin(report);
        const m = report.meta;
        const rule = m.rule === null ? "?" : (RULE_NAMES[m.rule] ?? m.rule);
        log(
          `● 牌譜開始錄（${rule}、地點 ${m.stage ?? "?"}、座位 ${m.side ?? "?"}${m.partial ? `，第 ${m.attachTurn ?? "?"} 回合才接上，前面沒錄到` : ""}）`,
        );
        return;
      }
      if (report.type === "kifu-events") {
        store.append(report);
        this.#counts.set(report.key, (this.#counts.get(report.key) ?? 0) + report.events.length);
        return;
      }
      store.end(report);
      const meta = this.#metas.get(report.key);
      const events = this.#counts.get(report.key) ?? 0;
      this.#metas.delete(report.key);
      this.#counts.delete(report.key);
      if (meta === undefined) {
        log(`· 牌譜收尾了一場沒看到開場的（${events} 則事件）—— 多半是托盤在戰鬥中途重開過`);
        return;
      }
      log(`● 牌譜存好了（${events} 則事件）`);
      const path = store.pathOf?.(report.key) ?? null;
      const saved: KifuSaved = { key: report.key, path, meta, events, reason: report.reason };
      if (page === null) {
        this.#opts.onSaved?.(saved);
        return;
      }
      const cache = this.#cache;
      this.#queue = this.#queue.then(async () => {
        const t0 = Date.now();
        try {
          const res = await snapshotMatch(page, store, meta, report, cache);
          store.writeSnapshot(report.key, res.snap);
          const kb = Math.round(res.bytes / 1024);
          const miss = res.snap.missing.length;
          log(
            `· 版本快照：${res.added === 0 ? "這個版本的資料與美術都存過了" : `新存 ${res.added} 個檔（${kb} KB）`}，${Date.now() - t0} ms${miss > 0 ? `；${miss} 項沒存到（${res.snap.missing.slice(0, 3).join("；")}${miss > 3 ? "…" : ""}）` : ""}`,
          );
        } catch (err) {
          log(`✗ 版本快照失敗：${describe(err)}（牌譜本身已經存好了）`);
        }
        this.#opts.onSaved?.(saved);
      });
    } catch (err) {
      log(`✗ 牌譜寫檔失敗：${describe(err)}`);
    }
  }
}
