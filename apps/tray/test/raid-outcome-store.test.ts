import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRaidOutcomes } from "../src/raid-outcome-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ulr-raid-outcomes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (key: string, outcome: string) => ({
  key,
  name: "龍鯰",
  found: Number(key),
  point: 100,
  outcome,
  at: 1,
});

describe("raid-outcomes.json", () => {
  it("沒有檔、壞掉的檔都回空的", () => {
    expect(readRaidOutcomes(join(dir, "none.json")).outcomes).toEqual([]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{", "utf8");
    expect(readRaidOutcomes(bad).outcomes).toEqual([]);
  });

  it("舊記錄檔補出來的匯入檔：這邊沒有的渦才收，併完寫回、匯入檔改名不再併", () => {
    const path = join(dir, "raid-outcomes.json");
    writeFileSync(path, JSON.stringify({ outcomes: [rec("2", "got")] }), "utf8");
    const imp = join(dir, "raid-outcomes.import.json");
    writeFileSync(imp, JSON.stringify({ outcomes: [rec("1", "lost"), rec("2", "lost")] }), "utf8");
    const s = readRaidOutcomes(path);
    expect(s.outcomes.map((x) => [x.key, x.outcome])).toEqual([
      ["1", "lost"],
      ["2", "got"],
    ]);
    expect(existsSync(imp)).toBe(false);
    expect(existsSync(`${imp}.imported`)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).outcomes).toHaveLength(2);
    expect(readRaidOutcomes(path).outcomes).toHaveLength(2);
  });
});
