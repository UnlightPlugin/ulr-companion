/**
 * 卡面替換的資料夾
 *
 * 要抓的是「檔名對不對得到卡」與「哪些檔會被安靜地跳過」—— 跳過的檔沒有
 * 錯誤訊息，玩家只會看到「我放了圖但卡面沒變」。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CardArtFs } from "../src/card-art.js";
import {
  countBlanks,
  installBundledBlanks,
  installDefaultMods,
  pngSize,
  resolveCardFrame,
  scanCardArtDir,
} from "../src/card-art.js";

/** 最小的合法 PNG 檔頭（只有簽章 + IHDR），寬高照參數。 */
function png(width: number, height: number, pad = 0): Buffer {
  const b = Buffer.alloc(24 + 9 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const names = { cc034: "史塔夏", cc001: "艾伯李斯特" };

function fakeFs(files: Record<string, Buffer>): CardArtFs {
  return {
    list: () => Object.keys(files),
    read: (_dir, f) => files[f] ?? Buffer.alloc(0),
    isFile: (_dir, f) => f in files,
  };
}

describe("pngSize", () => {
  it("從 IHDR 讀寬高", () => {
    expect(pngSize(png(168, 240))).toEqual({ width: 168, height: 240 });
  });
  it("不是 PNG 回 null", () => {
    expect(pngSize(Buffer.from("not a png at all, really"))).toBeNull();
  });
});

describe("resolveCardFrame", () => {
  it("格子鍵直接認，大小寫無所謂", () => {
    expect(resolveCardFrame("CC034_R01", null)).toEqual({ frame: "cc034_r01", label: "cc034_r01" });
    expect(resolveCardFrame("cc034_03", null)?.frame).toBe("cc034_03");
  });
  it("有名字表時格子鍵也給中文標籤", () => {
    expect(resolveCardFrame("cc034_r01", names)?.label).toBe("史塔夏 R1");
    expect(resolveCardFrame("cc034_02", names)?.label).toBe("史塔夏 L2");
  });
  it("中文名 + 格位", () => {
    expect(resolveCardFrame("史塔夏_R1", names)?.frame).toBe("cc034_r01");
    expect(resolveCardFrame("史塔夏 L1", names)?.frame).toBe("cc034_01");
    expect(resolveCardFrame("史塔夏R5", names)?.frame).toBe("cc034_r05");
    expect(resolveCardFrame("艾伯李斯特-l3", names)?.frame).toBe("cc001_03");
  });
  it("沒名字表時中文名對不到", () => {
    expect(resolveCardFrame("史塔夏_R1", null)).toBeNull();
  });
  it("名字表裡沒有的名字、格位超出 1~5 對不到", () => {
    expect(resolveCardFrame("不存在_R1", names)).toBeNull();
    expect(resolveCardFrame("史塔夏_R6", names)).toBeNull();
    expect(resolveCardFrame("cc034_r06", names)).toBeNull();
  });
});

describe("scanCardArtDir", () => {
  it("正常的檔進清單，dataUrl 是 PNG", () => {
    const scan = scanCardArtDir("x", names, fakeFs({ "史塔夏_R1.png": png(168, 240) }));
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]?.frame).toBe("cc034_r01");
    expect(scan.entries[0]?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(scan.files[0]?.problem).toBeNull();
    expect(scan.files[0]?.label).toBe("史塔夏 R1");
  });
  it("等比例放大的收、比例不對的拒絕", () => {
    const scan = scanCardArtDir(
      "x",
      names,
      fakeFs({ "cc034_r01.png": png(336, 480), "cc034_01.png": png(200, 200) }),
    );
    expect(scan.entries.map((e) => e.frame)).toEqual(["cc034_r01"]);
    const bad = scan.files.find((f) => f.file === "cc034_01.png");
    expect(bad?.problem).toMatch(/比例/);
  });
  it("對不到的檔留在清單上但不送", () => {
    const scan = scanCardArtDir("x", names, fakeFs({ "隨便.png": png(168, 240) }));
    expect(scan.entries).toHaveLength(0);
    expect(scan.files[0]?.problem).toMatch(/對不到/);
  });
  it("不是 PNG、開頭底線、非 png 副檔名都跳過", () => {
    const scan = scanCardArtDir(
      "x",
      names,
      fakeFs({
        "cc034_r01.png": Buffer.from("hello"),
        "_cc034_01.png": png(168, 240),
        "cc034_01.jpg": png(168, 240),
      }),
    );
    expect(scan.entries).toHaveLength(0);
    expect(scan.files.map((f) => f.file)).toEqual(["cc034_r01.png"]);
    expect(scan.files[0]?.problem).toBe("不是 PNG");
  });
  it("同一張卡兩個檔只用第一個，第二個標出來", () => {
    const scan = scanCardArtDir(
      "x",
      names,
      fakeFs({ "cc034_r01.png": png(168, 240), "史塔夏_R1.png": png(168, 240) }),
    );
    expect(scan.entries).toHaveLength(1);
    const dup = scan.files.find((f) => f.problem !== null);
    expect(dup?.problem).toMatch(/同一張卡/);
  });
});

describe("installBundledBlanks", () => {
  function setup() {
    const base = mkdtempSync(join(tmpdir(), "ulr-blanks-"));
    const bundle = join(base, "bundle");
    const blanks = join(base, "mods", "空框");
    for (const size of ["168x240", "336x480"]) {
      mkdirSync(join(bundle, size), { recursive: true });
      writeFileSync(join(bundle, size, "R1_框.png"), `${size}-v1`);
    }
    return { base, bundle, blanks };
  }

  it("第一次全部複製，各尺寸一個子資料夾", () => {
    const { base, bundle, blanks } = setup();
    try {
      expect(installBundledBlanks(bundle, blanks)).toEqual({ written: 2, bundled: 2 });
      expect(readFileSync(join(blanks, "336x480", "R1_框.png"), "utf8")).toBe("336x480-v1");
      expect(countBlanks(blanks)).toEqual({ "168x240": 1, "336x480": 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("同一版：玩家改過的不覆寫，刪掉的補回來", () => {
    const { base, bundle, blanks } = setup();
    try {
      installBundledBlanks(bundle, blanks);
      writeFileSync(join(blanks, "168x240", "R1_框.png"), "玩家改的");
      rmSync(join(blanks, "336x480", "R1_框.png"));
      expect(installBundledBlanks(bundle, blanks).written).toBe(1);
      expect(readFileSync(join(blanks, "168x240", "R1_框.png"), "utf8")).toBe("玩家改的");
      expect(existsSync(join(blanks, "336x480", "R1_框.png"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("內建那一份換版了就全部覆寫", () => {
    const { base, bundle, blanks } = setup();
    try {
      installBundledBlanks(bundle, blanks);
      writeFileSync(join(blanks, "168x240", "R1_框.png"), "舊的");
      writeFileSync(join(bundle, "168x240", "R1_框.png"), "168x240-v2");
      expect(installBundledBlanks(bundle, blanks).written).toBe(2);
      expect(readFileSync(join(blanks, "168x240", "R1_框.png"), "utf8")).toBe("168x240-v2");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("找不到內建那一份回 bundled 0，什麼都不寫", () => {
    const base = mkdtempSync(join(tmpdir(), "ulr-blanks-"));
    try {
      expect(installBundledBlanks(join(base, "nope"), join(base, "空框"))).toEqual({
        written: 0,
        bundled: 0,
      });
      expect(existsSync(join(base, "空框"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("installDefaultMods", () => {
  function setup() {
    const base = mkdtempSync(join(tmpdir(), "ulr-mods-"));
    const bundle = join(base, "bundle");
    const cards = join(base, "mods", "cards");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "史塔夏_R1.png"), "史塔夏-v1");
    writeFileSync(join(bundle, "音音夢_R4.png"), "音音夢-v1");
    return { base, bundle, cards };
  }

  it("第一次全部放好，第二次什麼都不寫", () => {
    const { base, bundle, cards } = setup();
    try {
      expect(installDefaultMods(bundle, cards)).toEqual({ written: 2, bundled: 2 });
      expect(readFileSync(join(cards, "史塔夏_R1.png"), "utf8")).toBe("史塔夏-v1");
      expect(installDefaultMods(bundle, cards).written).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("玩家刪掉的不補回來", () => {
    const { base, bundle, cards } = setup();
    try {
      installDefaultMods(bundle, cards);
      rmSync(join(cards, "史塔夏_R1.png"));
      expect(installDefaultMods(bundle, cards).written).toBe(0);
      expect(existsSync(join(cards, "史塔夏_R1.png"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("玩家本來就有的同名檔、改過的檔都不碰", () => {
    const { base, bundle, cards } = setup();
    try {
      mkdirSync(cards, { recursive: true });
      writeFileSync(join(cards, "音音夢_R4.png"), "玩家自己的");
      expect(installDefaultMods(bundle, cards).written).toBe(1);
      expect(readFileSync(join(cards, "音音夢_R4.png"), "utf8")).toBe("玩家自己的");
      writeFileSync(join(cards, "史塔夏_R1.png"), "玩家改的");
      writeFileSync(join(bundle, "史塔夏_R1.png"), "史塔夏-v2");
      expect(installDefaultMods(bundle, cards).written).toBe(0);
      expect(readFileSync(join(cards, "史塔夏_R1.png"), "utf8")).toBe("玩家改的");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("沒動過的、內建換版了就換成新版", () => {
    const { base, bundle, cards } = setup();
    try {
      installDefaultMods(bundle, cards);
      writeFileSync(join(bundle, "史塔夏_R1.png"), "史塔夏-v2");
      expect(installDefaultMods(bundle, cards).written).toBe(1);
      expect(readFileSync(join(cards, "史塔夏_R1.png"), "utf8")).toBe("史塔夏-v2");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("找不到內建那一份回 bundled 0，什麼都不寫", () => {
    const base = mkdtempSync(join(tmpdir(), "ulr-mods-"));
    try {
      expect(installDefaultMods(join(base, "nope"), join(base, "cards"))).toEqual({
        written: 0,
        bundled: 0,
      });
      expect(existsSync(join(base, "cards"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
