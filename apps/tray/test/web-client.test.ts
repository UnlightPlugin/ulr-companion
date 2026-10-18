import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportExtension, extVersion } from "../src/web-client.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ulr-webclient-"));
}

function fakeExtension(version = "9.9.9"): string {
  const dir = tmp();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "background.js"), "// bg");
  mkdirSync(join(dir, "icons"));
  writeFileSync(join(dir, "icons", "icon16.png"), "png");
  return dir;
}

describe("exportExtension", () => {
  it("放好擴充、回報版本；子資料夾（icons）一起複製", () => {
    const dest = join(tmp(), "ulr-steam-login");
    const r = exportExtension(fakeExtension(), dest);
    expect(r).toEqual({ dir: dest, version: "9.9.9" });
    expect(readFileSync(join(dest, "background.js"), "utf8")).toBe("// bg");
    expect(readFileSync(join(dest, "icons", "icon16.png"), "utf8")).toBe("png");
  });

  it("蓋掉舊版的檔，但不清空資料夾（玩家自己放的東西留著）", () => {
    const dest = tmp();
    writeFileSync(join(dest, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(dest, "mine.txt"), "keep");
    exportExtension(fakeExtension("2.0.0"), dest);
    expect(extVersion(dest)).toBe("2.0.0");
    expect(readFileSync(join(dest, "mine.txt"), "utf8")).toBe("keep");
  });
});

describe("extVersion", () => {
  it("沒裝回 null", () => {
    expect(extVersion(join(tmp(), "nope"))).toBeNull();
  });
});

describe("內建的 Steam 登入擴充", () => {
  const src = fileURLToPath(new URL("../assets/steam-login-extension", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as {
    key?: string;
    version?: string;
  };

  it("manifest 帶 key —— rules.json 用擴充 ID 認 Steam 連線，ID 不能隨資料夾路徑變", () => {
    expect(manifest.key).toBeTruthy();
    expect(readFileSync(join(src, "rules.json"), "utf8")).toContain(
      "lechoahegigppgncoehminhncchchpmp",
    );
  });

  it("讀得到版本（托盤靠它判斷要不要叫玩家更新）", () => {
    expect(extVersion(src)).toBe(manifest.version);
  });
});
