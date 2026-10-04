import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootExtVersion, exportBootExtension, gameFontDirs } from "../src/web-client.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ulr-webclient-"));
}

function fakeExtension(version = "9.9.9"): string {
  const dir = tmp();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "content.js"), "// content");
  return dir;
}

describe("exportBootExtension", () => {
  it("放好擴充、回報版本；沒有字型來源時 fonts = 0", () => {
    const dest = join(tmp(), "ulr-boot-extension");
    const r = exportBootExtension(fakeExtension(), dest);
    expect(r).toEqual({ dir: dest, version: "9.9.9", fonts: 0 });
    expect(readFileSync(join(dest, "content.js"), "utf8")).toBe("// content");
  });

  it("蓋掉舊版的檔，但不清空資料夾（玩家自己放的東西留著）", () => {
    const dest = tmp();
    writeFileSync(join(dest, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(dest, "mine.txt"), "keep");
    exportBootExtension(fakeExtension("2.0.0"), dest);
    expect(bootExtVersion(dest)).toBe("2.0.0");
    expect(readFileSync(join(dest, "mine.txt"), "utf8")).toBe("keep");
  });

  it("從第一個有字型的來源複製，只收字型檔", () => {
    const empty = tmp();
    const fonts = tmp();
    writeFileSync(join(fonts, "A.ttc"), "aaaa");
    writeFileSync(join(fonts, "B.otf"), "bb");
    writeFileSync(join(fonts, "notes.txt"), "x");
    const dest = tmp();
    const r = exportBootExtension(fakeExtension(), dest, [join(tmp(), "nope"), empty, fonts]);
    expect(r.fonts).toBe(2);
    expect(readFileSync(join(dest, "fonts", "A.ttc"), "utf8")).toBe("aaaa");
  });

  it("大小相同的字型不重寫（96MB，每按一次就寫一次沒有意義）", () => {
    const fonts = tmp();
    writeFileSync(join(fonts, "A.ttc"), "aaaa");
    const dest = tmp();
    mkdirSync(join(dest, "fonts"));
    const existing = join(dest, "fonts", "A.ttc");
    writeFileSync(existing, "zzzz");
    const old = new Date("2020-01-01");
    utimesSync(existing, old, old);
    exportBootExtension(fakeExtension(), dest, [fonts]);
    expect(readFileSync(existing, "utf8")).toBe("zzzz");
    expect(statSync(existing).mtime.getFullYear()).toBe(2020);
  });
});

describe("bootExtVersion", () => {
  it("沒裝回 null", () => {
    expect(bootExtVersion(join(tmp(), "nope"))).toBeNull();
  });
});

describe("gameFontDirs", () => {
  it("新版（fonts）排在舊版（public/fonts）前面，都在 resources 底下", () => {
    const dirs = gameFontDirs("R");
    expect(dirs[0]).toBe(join("R", "app.asar", "fonts"));
    expect(dirs).toContain(join("R", "app.asar", "public", "fonts"));
  });
});
