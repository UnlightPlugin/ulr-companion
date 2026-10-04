import { describe, expect, it } from "vitest";

import {
  buildTitleButtonScript,
  FALLBACK_TITLE_BG,
  parseTitleButtonLine,
  titleButtonLook,
} from "../src/title-button-core.js";

describe("buildTitleButtonScript", () => {
  it("把 pid 與 handle 填進去，不留佔位字", () => {
    const script = buildTitleButtonScript(15536, 656504n);
    expect(script).toContain("[uint32]15536");
    expect(script).toContain("[int64]656504");
    expect(script).not.toContain("__PID__");
    expect(script).not.toContain("__OVERLAY__");
  });

  it("C# 5 編不過的語法不能出現（Windows PowerShell 5.1 的 Add-Type）", () => {
    const script = buildTitleButtonScript(1, 1n);
    const cs = script.slice(script.indexOf('@"'), script.indexOf('"@'));
    expect(cs).not.toMatch(/\$"/); // 字串插值
    expect(cs).not.toMatch(/\)\s*=>/); // => 成員
    expect(cs).not.toMatch(/out var /);
    // 雙引號 here-string 會展開 $變數 —— C# 那段不能有 $
    expect(cs).not.toContain("$");
  });

  it("不合法的 pid／handle 直接丟錯", () => {
    expect(() => buildTitleButtonScript(0, 1n)).toThrow();
    expect(() => buildTitleButtonScript(1.5, 1n)).toThrow();
    expect(() => buildTitleButtonScript(1, 0n)).toThrow();
  });
});

describe("parseTitleButtonLine", () => {
  it("讀得懂三種回報", () => {
    expect(
      parseTitleButtonLine('{"type":"state","shown":true,"active":false,"bg":"#D09590"}'),
    ).toEqual({ type: "state", shown: true, active: false, bg: "#d09590" });
    expect(parseTitleButtonLine('{"type":"gone"}')).toEqual({ type: "gone" });
    expect(parseTitleButtonLine('{"type":"error","message":"x"}')).toEqual({
      type: "error",
      message: "x",
    });
  });

  it("還沒取到顏色（null）或格式不對：bg 是 null", () => {
    expect(parseTitleButtonLine('{"type":"state","shown":true,"active":true,"bg":null}')).toEqual({
      type: "state",
      shown: true,
      active: true,
      bg: null,
    });
    expect(
      parseTitleButtonLine('{"type":"state","shown":true,"active":true,"bg":"pink"}'),
    ).toMatchObject({ bg: null });
  });

  it("PowerShell 吐的雜訊、壞 JSON、不認得的 type 都回 null", () => {
    expect(parseTitleButtonLine("")).toBeNull();
    expect(parseTitleButtonLine("#< CLIXML")).toBeNull();
    expect(parseTitleButtonLine("{broken")).toBeNull();
    expect(parseTitleButtonLine('{"type":"what"}')).toBeNull();
  });
});

describe("titleButtonLook", () => {
  it("淺色的標題列（使用者的粉紅輔色）：黑色圖示、底色照抄", () => {
    const look = titleButtonLook("#d09590", true);
    expect(look.bg).toBe("#d09590");
    expect(look.glyph).toBe("#000000");
  });

  it("深色的標題列：白色圖示", () => {
    expect(titleButtonLook("#202020", true).glyph).toBe("#ffffff");
  });

  it("不在前景：圖示變灰", () => {
    expect(titleButtonLook("#2b2b2b", false).glyph).not.toBe("#ffffff");
    expect(titleButtonLook("#ffffff", false).glyph).not.toBe("#000000");
  });

  it("還沒取到顏色：用預設的深灰底", () => {
    expect(titleButtonLook(null, false).bg).toBe(FALLBACK_TITLE_BG);
  });
});
