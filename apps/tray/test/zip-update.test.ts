import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupUpdateLeftovers } from "../src/zip-update.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ulr-zip-update-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("暫存區的清理", () => {
  it("上一次留下的 zip、腳本與解開的那一份都清掉，腳本的記錄留著", () => {
    // 2026-10-12 卡住的那台機器上，暫存區就長這樣。
    mkdirSync(join(dir, "stage-2.3.0", "resources"), { recursive: true });
    writeFileSync(join(dir, "stage-2.3.0", "resources", "app.asar"), "不是真的 asar");
    writeFileSync(join(dir, "stage-2.3.0", "ULR Companion.exe"), "");
    writeFileSync(join(dir, "ulr-companion-2.3.0.zip"), "");
    writeFileSync(join(dir, "apply-2.3.0.ps1"), "");
    writeFileSync(join(dir, "apply-2.3.0.ready"), "");
    writeFileSync(join(dir, "apply-2.3.0.log"), "waiting for pid 1");

    expect(cleanupUpdateLeftovers(dir)).toBe(4);
    expect(readdirSync(dir)).toEqual(["apply-2.3.0.log"]);
  });

  it("暫存區不存在（從來沒更新過）不是錯誤", () => {
    const missing = join(dir, "updates");
    expect(cleanupUpdateLeftovers(missing)).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });

  it("清完不會把 process.noAsar 留在打開的狀態", () => {
    const before = process.noAsar;
    mkdirSync(join(dir, "stage-1.0.0"));
    cleanupUpdateLeftovers(dir);
    expect(process.noAsar).toBe(before);
  });
});
