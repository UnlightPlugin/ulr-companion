import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "@ulr/rule-schema/canonical";
import type { RuleManifest, UpdateManifest } from "../src/update-verify.js";
import { isNewerVersion, verifySignedFeed, verifySignedRuleFeed } from "../src/update-verify.js";

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

describe("只往新版走（防降版重播）", () => {
  it("⚠ 舊版本不會觸發更新 —— 舊清單的簽章永遠有效", () => {
    // 攻擊者拿到伺服器之後不必偽造任何東西，把半年前那份簽好的清單重播出來
    // 就能讓所有人裝回舊版（連同那一版已經修掉的問題）。
    expect(isNewerVersion("0.2.0", "0.2.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false);
  });

  it("同一版也不更新", () => {
    expect(isNewerVersion("0.2.1", "0.2.1")).toBe(false);
  });

  it("真的比較新才更新", () => {
    expect(isNewerVersion("0.2.1", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.2.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.2.10", "0.2.9")).toBe(true);
  });

  it("⚠ 看不懂的版本號一律拒絕，不要猜", () => {
    const cases: [string, string][] = [
      ["", "0.2.0"],
      ["0.2", "0.1.0"],
      ["1.2.3.4", "0.1.0"],
      ["v1.2.3", "0.1.0"],
      ["abc", "0.1.0"],
      ["0.2.1", "壞掉的"],
    ];
    for (const [a, b] of cases) {
      expect(isNewerVersion(a, b), `${a} vs ${b}`).toBe(false);
    }
  });
});

/**
 * 預設 COST 表的清單（WP-17）。
 *
 * ⚠ 跟發布清單共用同一把鑰匙與同一套正規化，所以這一組釘的是「**內容真的被
 * 簽章蓋到了**」—— 規則包整份帶在清單裡，改裡面任何一個數字都必須驗不過。
 */
describe("預設 COST 表的簽章", () => {
  const RULE_MANIFEST: RuleManifest = {
    ruleSetId: "tomorin/squeeze-band",
    version: "1.1.0",
    package: {
      packageVersion: 1,
      rule: { name: "夾擠式罰C", characters: { cc001_01: 17 } },
      contentHash: "sha256:" + "a".repeat(64),
    },
    notes: "測試用",
  };

  function signedRule(manifest: RuleManifest, key = keys.privateKey): unknown {
    return {
      manifest,
      signature: sign(null, Buffer.from(canonicalBytes(manifest)), key).toString("base64"),
    };
  }

  it("自己簽的自己驗得過", () => {
    expect(verifySignedRuleFeed(signedRule(RULE_MANIFEST), PUBLIC_PEM)).toEqual(RULE_MANIFEST);
  });

  it("⚠⚠ 改了規則內容就驗不過 —— 簽章蓋的是整份，不是只有版本號", () => {
    const feed = signedRule(RULE_MANIFEST) as { manifest: RuleManifest };
    // 一張卡從 17 改成 1：發布伺服器被入侵時最省事的那種竄改。
    (feed.manifest.package as { rule: { characters: Record<string, number> } }).rule.characters[
      "cc001_01"
    ] = 1;
    expect(verifySignedRuleFeed(feed, PUBLIC_PEM)).toBeNull();
  });

  it("別人的私鑰簽的不算", () => {
    expect(
      verifySignedRuleFeed(signedRule(RULE_MANIFEST, other.privateKey), PUBLIC_PEM),
    ).toBeNull();
  });

  it("形狀不對一律回 null，不拋例外", () => {
    const bad: unknown[] = [
      null,
      "字串",
      { manifest: RULE_MANIFEST },
      { manifest: { ...RULE_MANIFEST, ruleSetId: "沒有斜線" }, signature: "x" },
      { manifest: { ...RULE_MANIFEST, package: null }, signature: "x" },
      { manifest: { ...RULE_MANIFEST, version: "" }, signature: "x" },
      { manifest: RULE_MANIFEST, signature: "不是 base64 的簽章" },
    ];
    for (const raw of bad) {
      expect(() => verifySignedRuleFeed(raw, PUBLIC_PEM)).not.toThrow();
      expect(verifySignedRuleFeed(raw, PUBLIC_PEM)).toBeNull();
    }
  });
});
