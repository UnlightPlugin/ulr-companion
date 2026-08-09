import { describe, expect, it } from "vitest";
import {
  clampHazardShorten,
  clampPhaseSeconds,
  clampSpeedFactor,
  decode,
  DEFAULT_PHASE_SECONDS,
  DEFAULT_PREFS,
  effectiveCapSeconds,
  encode,
  isCompatible,
  LINK_PROTOCOL_VERSION,
  MAX_SPEED_FACTOR,
  MIN_PHASE_SECONDS,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
  negotiate,
  normalizePrefs,
  roomKey,
  soloSettings,
} from "../src/protocol.js";
import type { AgreedSettings, LinkPrefs } from "../src/protocol.js";

const prefs = (over: Partial<LinkPrefs> = {}): LinkPrefs => ({ ...DEFAULT_PREFS, ...over });
const agreed = (over: Partial<AgreedSettings> = {}): AgreedSettings => ({
  ...DEFAULT_PREFS,
  ...over,
});

describe("協商", () => {
  it("秒數取比較長的那一邊（玩家原話：我 10、對方 15 → 15）", () => {
    const agreed = negotiate(prefs({ phaseSeconds: 10 }), prefs({ phaseSeconds: 15 }));
    expect(agreed.phaseSeconds).toBe(15);
  });

  it("順序不影響結果", () => {
    const a = prefs({ phaseSeconds: 10, hazardShortenSeconds: 5 });
    const b = prefs({ phaseSeconds: 15, hazardShortenSeconds: 0 });
    expect(negotiate(a, b)).toEqual(negotiate(b, a));
  });

  it("⚠ 一方關掉聖水規則，共同值就是 0 —— 不能硬加給他", () => {
    const agreed = negotiate(
      prefs({ hazardShortenSeconds: 5 }),
      prefs({ hazardShortenSeconds: 0 }),
    );
    expect(agreed.hazardShortenSeconds).toBe(0);
  });

  it("準備功能要兩邊都開才成立", () => {
    expect(
      negotiate(prefs({ readyEnabled: true }), prefs({ readyEnabled: false })).readyEnabled,
    ).toBe(false);
    expect(
      negotiate(prefs({ readyEnabled: true }), prefs({ readyEnabled: true })).readyEnabled,
    ).toBe(true);
  });

  it("⚠ 任何一方都不可能被強加自己沒同意的限制", () => {
    // 這是紅線 2 的一般化版本：協商結果對每一邊來說都不比他自己選的更嚴格。
    for (const mine of [5, 12, 20, 30]) {
      for (const theirs of [5, 12, 20, 30]) {
        const agreed = negotiate(prefs({ phaseSeconds: mine }), prefs({ phaseSeconds: theirs }));
        expect(agreed.phaseSeconds).toBeGreaterThanOrEqual(mine);
        expect(agreed.phaseSeconds).toBeGreaterThanOrEqual(theirs);
      }
    }
  });
});

describe("預設值", () => {
  it("移動階段預設 20 秒", () => {
    expect(DEFAULT_PREFS.phaseSeconds).toBe(DEFAULT_PHASE_SECONDS);
    expect(DEFAULT_PHASE_SECONDS).toBe(20);
  });

  it("⚠ 預設就縮短是安全的 —— 兩邊拿到同一個預設，不對稱不存在", () => {
    // 雙方都用預設 → 共同值就是 20（取 max，兩邊一樣）。
    expect(negotiate(prefs(), prefs()).phaseSeconds).toBe(20);
    // 但對手想要滿版就是滿版 —— 沒有人被強加自己沒同意的限制。
    expect(negotiate(prefs(), prefs({ phaseSeconds: 30 })).phaseSeconds).toBe(30);
  });

  it("⚠ 沒配到對手時仍然還原成滿版 —— 改預設值不會讓單邊的人被縮短", () => {
    expect(soloSettings(prefs()).phaseSeconds).toBe(MOVE_PHASE_TOTAL_SECONDS);
  });
});

describe("單邊模式", () => {
  it("⚠ 沒配對到人時秒數還原成滿版 —— 單方面縮短只是自損", () => {
    expect(soloSettings(prefs({ phaseSeconds: 10 })).phaseSeconds).toBe(MOVE_PHASE_TOTAL_SECONDS);
    expect(soloSettings(prefs({ hazardShortenSeconds: 5 })).hazardShortenSeconds).toBe(0);
  });

  it("⚠ 準備功能也一律關掉 —— 沒握手成功就什麼都不做（玩家 2026-08-09 指定）", () => {
    // 這條推翻了先前「單邊保留誤按反悔窗口」的設計。理由是那個窗口在單邊時
    // **只有成本沒有收益**：收益（對手也停下來等）需要對手也有插件，
    // 而成本（我的 OK 被壓著、對手照樣在動）單邊就要付。
    //
    // 於是四個欄位現在是同一個意思：沒握手就什麼都不做。
    expect(soloSettings(prefs({ readyEnabled: true })).readyEnabled).toBe(false);
    expect(soloSettings(prefs({ readyEnabled: false })).readyEnabled).toBe(false);
  });

  it("⚠ 加速在單邊一律關掉 —— 它提早把決策窗還給我，對手沒有", () => {
    expect(soloSettings(prefs({ speedFactor: 10 })).speedFactor).toBe(MIN_SPEED_FACTOR);
  });
});

describe("加速（雙方都勾才算數）", () => {
  it("一方沒勾，共同值就是原速", () => {
    expect(negotiate(prefs({ speedFactor: 3 }), prefs({ speedFactor: 1 })).speedFactor).toBe(1);
  });

  it("兩邊都勾就取比較小的那個 —— 沒有人被強加自己沒選的倍率", () => {
    expect(negotiate(prefs({ speedFactor: 3 }), prefs({ speedFactor: 2 })).speedFactor).toBe(2);
    for (const mine of [1, 1.5, 3, 10]) {
      for (const theirs of [1, 1.5, 3, 10]) {
        const both = negotiate(prefs({ speedFactor: mine }), prefs({ speedFactor: theirs }));
        expect(both.speedFactor).toBeLessThanOrEqual(mine);
        expect(both.speedFactor).toBeLessThanOrEqual(theirs);
      }
    }
  });

  it("⚠ 舊版對手的 hello 不帶這個欄位 → 當成沒開，加速自動失效", () => {
    const theirs = normalizePrefs({ phaseSeconds: 15 } as Partial<LinkPrefs>);
    expect(theirs.speedFactor).toBe(MIN_SPEED_FACTOR);
    expect(negotiate(prefs({ speedFactor: 3 }), theirs).speedFactor).toBe(MIN_SPEED_FACTOR);
  });

  it("倍率夾在 1~10，取到小數一位", () => {
    expect(clampSpeedFactor(0)).toBe(MIN_SPEED_FACTOR);
    expect(clampSpeedFactor(99)).toBe(MAX_SPEED_FACTOR);
    expect(clampSpeedFactor(2.47)).toBe(2.5);
    expect(clampSpeedFactor(Number.NaN)).toBe(MIN_SPEED_FACTOR);
  });
});

describe("實際門檻", () => {
  it("沒有聖水組合就是協商出來的秒數", () => {
    expect(effectiveCapSeconds(agreed({ phaseSeconds: 15, hazardShortenSeconds: 5 }), false)).toBe(
      15,
    );
  });

  it("聖水＋麻痺再提早 5 秒", () => {
    expect(effectiveCapSeconds(agreed({ phaseSeconds: 15, hazardShortenSeconds: 5 }), true)).toBe(
      10,
    );
  });

  it("⚠ 修正項可以疊，下限不行", () => {
    expect(effectiveCapSeconds(agreed({ phaseSeconds: 6, hazardShortenSeconds: 5 }), true)).toBe(
      MIN_PHASE_SECONDS,
    );
  });
});

describe("夾範圍", () => {
  it("秒數夾在 5~30 並取整", () => {
    expect(clampPhaseSeconds(0)).toBe(MIN_PHASE_SECONDS);
    expect(clampPhaseSeconds(99)).toBe(MOVE_PHASE_TOTAL_SECONDS);
    expect(clampPhaseSeconds(12.4)).toBe(12);
    expect(clampPhaseSeconds(Number.NaN)).toBe(MOVE_PHASE_TOTAL_SECONDS);
  });

  it("縮減秒數不得為負", () => {
    expect(clampHazardShorten(-3)).toBe(0);
    expect(clampHazardShorten(999)).toBe(MOVE_PHASE_TOTAL_SECONDS - MIN_PHASE_SECONDS);
  });

  it("normalizePrefs 對缺欄位與垃圾值都給得出合法結果", () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ phaseSeconds: -1 })).toEqual({
      ...DEFAULT_PREFS,
      phaseSeconds: MIN_PHASE_SECONDS,
    });
  });
});

describe("房號", () => {
  it("⚠ 原始 room id 不會出現在房號裡（§12）", () => {
    const raw = "w1gofnRGcnyVLKAYbFvoCD7S1DEAKHMa";
    const key = roomKey(raw);
    expect(key).not.toContain(raw);
    expect(raw).not.toContain(key);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("同一個 room id 兩邊算出同一個房號", () => {
    expect(roomKey("abc")).toBe(roomKey("abc"));
    expect(roomKey("abc")).not.toBe(roomKey("abd"));
  });
});

describe("版本", () => {
  it("只認完全相同的版本", () => {
    expect(isCompatible(LINK_PROTOCOL_VERSION)).toBe(true);
    expect(isCompatible(LINK_PROTOCOL_VERSION + 1)).toBe(false);
    expect(isCompatible(LINK_PROTOCOL_VERSION - 1)).toBe(false);
  });
});

describe("序列化", () => {
  it("來回一趟不變形", () => {
    const message = {
      t: "hello" as const,
      v: LINK_PROTOCOL_VERSION,
      room: "deadbeefdeadbeef",
      prefs: prefs({ phaseSeconds: 15 }),
    };
    expect(decode(encode(message))).toEqual(message);
  });

  it("⚠ 壞掉的訊息一律回 null，絕不拋例外", () => {
    for (const bad of ["", "{", "null", "[]", '"str"', "{}", '{"t":123}', '{"t":"nope"}']) {
      expect(decode(bad)).toBeNull();
    }
  });

  it("缺欄位的 hello 會被補成合法的 prefs，而不是整則丟掉", () => {
    const decoded = decode('{"t":"hello","v":1,"room":"x"}');
    expect(decoded).toEqual({ t: "hello", v: 1, room: "x", prefs: DEFAULT_PREFS });
  });

  it("ready 少了布林就整則丟掉 —— 猜一個預設值會改變勝負", () => {
    expect(decode('{"t":"ready"}')).toBeNull();
  });
});
