import { describe, expect, it } from "vitest";

import {
  buildTitleButtonScript,
  parseTitleButtonLine,
  titleButtonLaunch,
} from "../src/title-button-core.js";

describe("buildTitleButtonScript", () => {
  it("把 pid 填進去，不留佔位字", () => {
    const script = buildTitleButtonScript(15536);
    expect(script).toContain("[uint32]15536");
    expect(script).not.toContain("__PID__");
  });

  it("C# 5 編不過的語法不能出現（Windows PowerShell 5.1 的 Add-Type）", () => {
    const script = buildTitleButtonScript(1);
    const cs = script.slice(script.indexOf('@"'), script.indexOf('"@'));
    expect(cs).not.toMatch(/\$"/); // 字串插值
    expect(cs).not.toContain("=>"); // => 成員（lambda 也一起擋，用 delegate）
    expect(cs).not.toMatch(/out var /);
    expect(cs).not.toMatch(/\?\./); // null 條件
    expect(cs).not.toMatch(/\bnameof\b/);
    // 雙引號 here-string 會展開 $變數、吃反引號 —— C# 那段兩個都不能有
    expect(cs).not.toContain("$");
    expect(cs).not.toContain("`");
  });

  it("C# 的字串字面值裡不放非 ASCII（Add-Type 經暫存檔編譯，編碼不保證）", () => {
    const cs = buildTitleButtonScript(1);
    const code = cs
      .slice(cs.indexOf('@"'), cs.indexOf('"@'))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$|\/\*.*\*\//, ""))
      .join("\n");
    for (const literal of code.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []) {
      expect(literal).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("命令列塞得下（Windows 上限 32767 字，主腳本走 stdin）", () => {
    const { args, stdin } = titleButtonLaunch(15536);
    expect(args.join(" ").length).toBeLessThan(2000);
    expect(Buffer.from(stdin, "base64").toString("utf8")).toBe(buildTitleButtonScript(15536));
  });

  it("不合法的 pid 直接丟錯", () => {
    expect(() => buildTitleButtonScript(0)).toThrow();
    expect(() => buildTitleButtonScript(1.5)).toThrow();
  });
});

describe("parseTitleButtonLine", () => {
  it("讀得懂三種回報", () => {
    expect(parseTitleButtonLine('{"type":"click"}')).toEqual({ type: "click" });
    expect(parseTitleButtonLine('{"type":"gone"}')).toEqual({ type: "gone" });
    expect(parseTitleButtonLine('{"type":"error","message":"x"}')).toEqual({
      type: "error",
      message: "x",
    });
  });

  it("PowerShell 吐的雜訊、壞 JSON、不認得的 type 都回 null", () => {
    expect(parseTitleButtonLine("")).toBeNull();
    expect(parseTitleButtonLine("#< CLIXML")).toBeNull();
    expect(parseTitleButtonLine("{broken")).toBeNull();
    expect(parseTitleButtonLine('{"type":"what"}')).toBeNull();
  });
});
