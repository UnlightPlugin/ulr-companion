import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "@ulr/rule-schema";
import type { UpdateManifest } from "../src/update-verify.js";
import { verifySignedFeed } from "../src/update-verify.js";

const keys = generateKeyPairSync("ed25519");
const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const other = generateKeyPairSync("ed25519");
const OTHER_PUBLIC_PEM = other.publicKey.export({ type: "spki", format: "pem" }).toString();

const MANIFEST: UpdateManifest = {
  version: "0.2.0",
  url: "https://github.com/UnlightPlugin/ulr-companion/releases/download/v0.2.0/setup.exe",
  sha256: "a".repeat(64),
  notes: "測試用",
};

function signedWith(
  manifest: unknown,
  key = keys.privateKey,
): { manifest: unknown; signature: string } {
  return {
    manifest,
    signature: sign(null, Buffer.from(canonicalBytes(manifest)), key).toString("base64"),
  };
}

describe("發布清單的簽章", () => {
  it("簽章對就回清單", () => {
    expect(verifySignedFeed(signedWith(MANIFEST), PUBLIC_PEM)).toEqual(MANIFEST);
  });

  it("欄位順序不影響結果 —— 簽的是正規化之後的位元組", () => {
    const reordered = {
      sha256: MANIFEST.sha256,
      notes: MANIFEST.notes,
      url: MANIFEST.url,
      version: MANIFEST.version,
    };
    // 用重排過的物件簽，再用原本的順序驗 —— JCS 正規化讓兩者等價。
    const feed = signedWith(reordered);
    expect(verifySignedFeed({ ...feed, manifest: MANIFEST }, PUBLIC_PEM)).toEqual(MANIFEST);
  });

  it("⚠ 動過任何一個欄位就驗不過", () => {
    // 這是整個防護的核心：伺服器被入侵時，攻擊者能改內容但簽不出新的簽章。
    const feed = signedWith(MANIFEST);
    for (const patch of [
      { url: "https://evil.example/setup.exe" },
      { sha256: "b".repeat(64) },
      { version: "9.9.9" },
      { notes: "被改過" },
    ]) {
      const tampered = { ...feed, manifest: { ...MANIFEST, ...patch } };
      expect(verifySignedFeed(tampered, PUBLIC_PEM), JSON.stringify(patch)).toBeNull();
    }
  });

  it("⚠ 換一把私鑰簽也驗不過", () => {
    expect(verifySignedFeed(signedWith(MANIFEST, other.privateKey), PUBLIC_PEM)).toBeNull();
  });

  it("⚠ 換一把公鑰驗也不過（金鑰換掉 = 舊版全部收不到更新）", () => {
    expect(verifySignedFeed(signedWith(MANIFEST), OTHER_PUBLIC_PEM)).toBeNull();
  });

  it("沒有簽章、簽章長度不對、不是 base64 —— 全部拒絕", () => {
    expect(verifySignedFeed({ manifest: MANIFEST }, PUBLIC_PEM)).toBeNull();
    expect(verifySignedFeed({ manifest: MANIFEST, signature: "" }, PUBLIC_PEM)).toBeNull();
    expect(verifySignedFeed({ manifest: MANIFEST, signature: "AAAA" }, PUBLIC_PEM)).toBeNull();
    expect(verifySignedFeed({ manifest: MANIFEST, signature: 123 }, PUBLIC_PEM)).toBeNull();
  });

  it("⚠ 公鑰少了 PEM 外框也要能用 —— 那個手滑會安靜殺掉整個更新機制", () => {
    // keygen 印的是完整 PEM，但人在貼的時候很自然只選中間那串 base64。
    // 少了外框 createPublicKey() 會丟例外 → 被吞掉 → 每一份清單都驗不過，
    // 而畫面上看起來「自動更新在跑」。
    const bare = PUBLIC_PEM.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    expect(verifySignedFeed(signedWith(MANIFEST), bare)).toEqual(MANIFEST);
  });

  it("⚠ 沒有公鑰時一律拒絕 —— 沒有信任根就不該更新", () => {
    expect(verifySignedFeed(signedWith(MANIFEST), "")).toBeNull();
    expect(verifySignedFeed(signedWith(MANIFEST), "not a pem")).toBeNull();
  });

  it("清單缺欄位或雜湊格式不對就拒絕", () => {
    for (const bad of [
      { version: "1.0.0", url: "https://x/y" }, // 沒有 sha256
      { version: "1.0.0", url: "https://x/y", sha256: "太短" },
      { version: "1.0.0", url: "https://x/y", sha256: "A".repeat(64) }, // 大寫
      { version: "", url: "https://x/y", sha256: "a".repeat(64) },
      { version: "1.0.0", url: "", sha256: "a".repeat(64) },
      { version: "1.0.0", url: "https://x/y", sha256: "a".repeat(64), notes: 5 },
    ]) {
      // 就算簽章是對的也一樣 —— 形狀不合格的清單本來就不該被信任。
      expect(verifySignedFeed(signedWith(bad), PUBLIC_PEM), JSON.stringify(bad)).toBeNull();
    }
  });

  it("壞掉的輸入一律回 null，不拋例外", () => {
    for (const bad of [null, undefined, 42, "x", [], {}, { manifest: 1, signature: "x" }]) {
      expect(verifySignedFeed(bad, PUBLIC_PEM)).toBeNull();
    }
  });
});
