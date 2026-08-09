/**
 * 發布清單的簽章驗證（純函式，無 I/O）
 * ======================================
 * 自動更新這條路的信任根。**這支錯了，`updater.ts` 的所有防護都是裝飾。**
 *
 * ## 為什麼 SHA-256 不夠
 *
 * `updater.ts` 本來就會驗安裝檔的雜湊 —— 但**那個雜湊寫在發布清單裡，而清單
 * 來自伺服器**。伺服器被入侵的話，攻擊者同時控制「要下載什麼」與「它的雜湊
 * 應該是多少」，等於自己批改自己的作業。雜湊防得了「檔案在路上被換掉」和
 * 「只有檔案儲存空間被入侵」，防不了「發清單的那台被入侵」。
 *
 * 而那件事的後果是**任意程式碼在每一台裝了插件的電腦上靜默執行**：清單說有
 * 新版 → 下載 → 雜湊自己對得上 → `spawn(exe, ["/S"])`。全程不需要玩家點任何
 * 東西，因為「不打擾」正是那個功能的設計目標。
 *
 * ## 所以清單要簽章
 *
 * 私鑰**離線保管，不進 repo、不進 CI、不進 Cloudflare**；公鑰烤進客戶端。
 * 於是即使 Cloudflare 帳號被盜，攻擊者也推不出任何一版 —— 他沒有私鑰，
 * 而客戶端在讀 `version` 之前就先拒絕了。
 *
 * ⚠ **驗章要在「相信清單裡任何一個欄位之前」發生。** 先比版本再驗章的話，
 * 攻擊者仍然可以用一份沒簽的清單控制流程走向。
 *
 * ## 簽的是什麼
 *
 * `canonicalize(manifest)` 的 UTF-8 位元組 —— 就是 WP-01 那套 JCS 正規化
 * （`@ulr/rule-schema`）。重用它而不是自己定一個序列化格式，理由跟當初一樣：
 * **兩邊對不上的時候不會報錯，只會安靜地驗不過**，而那種 bug 極難查。
 * 它已經有跨語言測試向量，之後 ULGG 端要簽也照得出來。
 */

import { createPublicKey, verify } from "node:crypto";
import { canonicalBytes } from "@ulr/rule-schema/canonical";

/** 發布清單本身。跟 `apps/link-worker/src/release.ts` 的形狀一致。 */
export interface UpdateManifest {
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

/**
 * 伺服器回的東西：清單 + 它的簽章。
 *
 * ⚠ **簽章放在清單外面。** 放進去的話「簽章要不要算進被簽的內容」會變成一個
 * 先有雞還是先有蛋的問題，而每個實作都會給出不一樣的答案。
 */
export interface SignedFeed {
  manifest: UpdateManifest;
  /** base64 的 Ed25519 簽章（64 bytes）。 */
  signature: string;
}

/** Ed25519 簽章固定 64 bytes。長度不對就不必進到密碼學那一層。 */
const SIGNATURE_BYTES = 64;

function isManifest(value: unknown): value is UpdateManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m["version"] !== "string" || m["version"].length === 0) return false;
  if (typeof m["url"] !== "string" || m["url"].length === 0) return false;
  // ⚠ 沒有雜湊就整份丟掉。簽章保證清單是我們發的，雜湊保證下載到的檔案就是
  // 清單指的那一個 —— 兩層都要，少一層都有一條路徑沒被蓋到。
  if (typeof m["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(m["sha256"])) return false;
  if (m["notes"] !== undefined && typeof m["notes"] !== "string") return false;
  return true;
}

/**
 * `candidate` 是不是**嚴格比** `current` 新。
 *
 * ⚠⚠ **這一條是防「降版攻擊」（rollback）的，簽章擋不住它。**
 *
 * 簽章保證「這份清單是我們發的」，但**舊清單的簽章永遠有效** —— 攻擊者拿到
 * 伺服器之後不必偽造任何東西，只要把半年前那份簽好的清單**重播**出來，
 * 每一台客戶端就會乖乖裝回舊版，包括那一版所有已經修掉的問題。
 *
 * 原本的判斷是 `manifest.version !== currentVersion`（不一樣就更新），
 * 那對重播完全沒有抵抗力。改成「只往新的走」之後，重播舊清單的結果是
 * **什麼都不會發生**。
 *
 * 解析不了的版本號一律回 `false`。**拒絕比猜測安全** —— 看不懂的東西不該
 * 觸發一次靜默安裝。
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    // 只認 `1.2.3`（後面可以有 `-beta.1` 之類的東西，但那不參與比較 ——
    // 預發布版的排序規則很微妙，而這個專案還不需要它）。
    const core = v.trim().split("-")[0] ?? "";
    const parts = core.split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
    return nums.some((n) => Number.isNaN(n)) ? null : nums;
  };

  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * 把公鑰整理成 `createPublicKey()` 吃得下的樣子。
 *
 * ⚠ **這是為了一個會安靜殺掉整個更新機制的手滑。** `keygen` 印出來的是完整
 * PEM（含 `-----BEGIN PUBLIC KEY-----` 外框），但人在貼的時候很自然只會選中間
 * 那串 base64 —— 而少了外框 `createPublicKey()` 會直接丟例外，被這支的
 * try/catch 吞掉，變成「每一份清單都驗不過」。
 *
 * 症狀是最糟的那種：**自動更新看起來在跑，實際上永遠不會更新**，記錄裡也只有
 * 一行「檢查更新失敗」。所以這裡直接接受兩種寫法。
 */
function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  // 裸的 base64（SPKI DER）—— 補上外框。
  return `-----BEGIN PUBLIC KEY-----\n${trimmed}\n-----END PUBLIC KEY-----\n`;
}

/**
 * 驗一份簽過的發布清單。**驗不過一律回 `null`，絕不拋例外。**
 *
 * 拋例外的代價是「更新整支停掉，而且玩家看不到任何原因」—— 那跟被入侵一樣
 * 難查，只是方向相反。呼叫端只要把 `null` 當成「這次沒有可信的更新」。
 *
 * @param raw 伺服器回來的 JSON（`unknown`，什麼形狀都可能）
 * @param publicKeyPem 烤進客戶端的公鑰（SPKI PEM）
 */
export function verifySignedFeed(raw: unknown, publicKeyPem: string): UpdateManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const feed = raw as Record<string, unknown>;

  const manifest = feed["manifest"];
  const signature = feed["signature"];
  if (!isManifest(manifest)) return null;
  if (typeof signature !== "string" || signature.length === 0) return null;

  let sig: Buffer;
  try {
    sig = Buffer.from(signature, "base64");
  } catch {
    return null;
  }
  if (sig.length !== SIGNATURE_BYTES) return null;

  try {
    const key = createPublicKey(normalizeKey(publicKeyPem));
    // ⚠ Ed25519 的演算法參數必須是 `null` —— 它自己就規定了雜湊函式（SHA-512）。
    // 傳別的東西進去 Node 會直接丟例外。
    const ok = verify(null, Buffer.from(canonicalBytes(manifest)), key, sig);
    return ok ? manifest : null;
  } catch {
    // 公鑰壞掉、簽章格式壞掉、正規化失敗 —— 全部都是「不可信」。
    return null;
  }
}
