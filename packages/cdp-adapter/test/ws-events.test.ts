import { runInNewContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { WS_CLIENT } from "../src/constants.js";
import { buildWsWatchScript, isWsWatchReport } from "../src/ws-events.js";

const script = buildWsWatchScript({ bindingName: "__test_binding" });

describe("buildWsWatchScript", () => {
  it("產生的是語法正確的 JS", () => {
    // 只編譯不執行 —— 語法錯誤在這裡就會炸，不必真的有遊戲。
    expect(() => new Script(script)).not.toThrow();
  });

  it("重複求值不會把 emit 疊好幾層，但換得掉設定", () => {
    // 疊兩層會讓每個送出事件被回報兩次，而牌譜靠的就是次數。
    // 但單純早退也不行 —— 那樣第一次裝好之後取值清單就再也改不了，
    // 只能重載遊戲（2026-08-02 真的踩到，整輪錄下來全是形狀沒有值）。
    expect(script).toContain('return "updated"');
    expect(script).toContain("window[FLAG].valueEvents = buildValueSet");
  });

  it("handler 從 window[FLAG] 取設定，不用閉包變數", () => {
    // 重新求值跑的是新閉包，舊 handler 抓著的還是舊那份 —— 用閉包就永遠
    // 換不掉設定，而且症狀是「指令說更新成功但輸出沒變」。
    expect(script).toContain("function live()");
    expect(script).toContain("var st = live();");
  });

  it("送出側是 patch 原型，不是逐個實例", () => {
    // 6~8 條連線共用同一份原型，patch 一次全包（open-questions §4）。
    expect(script).toContain("Object.getPrototypeOf");
    expect(script).toContain(WS_CLIENT.sendMethod);
  });

  it("先跑遊戲原本的 emit，再做我們的", () => {
    // 順序不能顛倒 —— 我們拋例外時遊戲該做的事已經做完了。
    const original = script.indexOf("original.apply(this, arguments)");
    const ours = script.indexOf('emitEvent("out"');
    expect(original).toBeGreaterThan(-1);
    expect(ours).toBeGreaterThan(original);
  });

  it("路徑與方法名是從 constants 帶進去的，不是寫死", () => {
    // 遊戲改版換路徑時只要改 constants.ts。
    expect(script).toContain(WS_CLIENT.listenAllMethod);
    expect(script).toContain(WS_CLIENT.instancePath);
  });
});

/**
 * 把注入腳本裡的 `shapeOf` 挖出來單獨跑。
 *
 * 這個函式是「事件目錄要的結構」與「不得外洩的值」之間唯一那條線，
 * 所以它必須被直接測 —— 光看整段腳本編譯得過不能保證它不吐值。
 *
 * 用 node:vm 而不是 `new Function` —— 後者被 eslint 的 no-new-func 擋，
 * 而且 vm 的沙箱本來就是這個 repo 測注入腳本的既定做法。
 */
function runShapeOf(
  value: unknown,
  opts: { withValues?: boolean; maxKeys?: number; maxStr?: number } = {},
): string {
  const body = script.slice(
    script.indexOf("function shapeOf(v, withValues, depth) {"),
    script.indexOf("function shapesFrom"),
  );
  const sandbox = {
    CFG: { maxKeys: opts.maxKeys ?? 12, maxDepth: 3, maxStr: opts.maxStr ?? 24 },
    // `has` 宣告在腳本開頭，不在切出來的這一段裡。少了它 shapeOf 會被自己的
    // try/catch 吞成 "obj(?)" —— 看起來像通過，其實根本沒跑到列鍵那段。
    has: Object.prototype.hasOwnProperty,
    input: value,
    withValues: opts.withValues ?? false,
    output: "",
  };
  runInNewContext(`${body}\noutput = shapeOf(input, withValues, 0);`, sandbox);
  return sandbox.output;
}

describe("shapeOf（§12 的界線）", () => {
  const shapeOf = (value: unknown, maxKeys = 12): string => runShapeOf(value, { maxKeys });

  it("字串只給長度，不給內容", () => {
    // db_deck1/2/3 送出時 args[0] 是 session token，§12 明訂不得記錄。
    expect(shapeOf("a-session-token-that-is-secret")).toBe("str(30)");
    expect(shapeOf("a-session-token-that-is-secret")).not.toContain("secret");
  });

  it("物件列鍵不列值", () => {
    // 鍵是結構（事件目錄需要的），值才是機密。
    const out = shapeOf({ chara: "cc078", charaIndex: 775, level: 4 });
    expect(out).toBe("obj{chara,charaIndex,level}");
    expect(out).not.toContain("cc078");
    expect(out).not.toContain("775");
  });

  it("鍵太多會截斷", () => {
    const many = Object.fromEntries([...Array(20).keys()].map((i) => [`k${i}`, i]));
    expect(shapeOf(many, 3)).toBe("obj{k0,k1,k2,…}");
  });

  it("數字不吐值", () => {
    // 單一數字看起來無害，但 HP、手牌強度都是數字。一律只說型別。
    expect(shapeOf(42)).toBe("num");
  });

  it("陣列只給長度", () => {
    expect(shapeOf([1, 2, 3])).toBe("arr(3)");
  });

  it("null / undefined 分得開", () => {
    expect(shapeOf(null)).toBe("null");
    expect(shapeOf(undefined)).toBe("undefined");
  });
});

describe("取值模式（允許清單解鎖純量，但擋不掉長字串）", () => {
  const shapeOf = (value: unknown, withValues: boolean, maxStr = 24): string =>
    runShapeOf(value, { withValues, maxStr });

  it("允許清單裡的事件才帶出數字", () => {
    expect(shapeOf(42, false)).toBe("num");
    expect(shapeOf(42, true)).toBe("42");
  });

  it("擲骰結果挖得出正骰數與骰面", () => {
    // 這就是加取值模式的原因 —— 「正骰率是不是 1/3」問的就是這些值。
    const dice = { atkArr: [1, 0, 1], defArr: [0, 0], atkSuc: 2, defSuc: 0 };
    expect(shapeOf(dice, false)).toBe("obj{atkArr,defArr,atkSuc,defSuc}");
    expect(shapeOf(dice, true)).toBe("obj{atkArr:[1,0,1],defArr:[0,0],atkSuc:2,defSuc:0}");
  });

  it("⚠ 長字串就算在允許清單裡也只給長度", () => {
    // token(32) 與 match id(36) 都是字串。允許清單若能覆蓋這條，界線就沒了。
    const token = "a".repeat(32);
    const matchId = "b".repeat(36);
    expect(shapeOf(token, true)).toBe("str(32)");
    expect(shapeOf(matchId, true)).toBe("str(36)");
    expect(shapeOf(token, true)).not.toContain("aaa");
  });

  it("短字串取得到 —— 移動選擇就靠這個", () => {
    // move_select 的送出格式是 str(32) str(36) str(4)：同一則裡既有 token
    // 也有我們要的選擇，長度上限是唯一分得開它們的東西。
    const args = ["a".repeat(32), "b".repeat(36), "back"];
    const out = args.map((a) => shapeOf(a, true));
    expect(out).toEqual(["str(32)", "str(36)", '"back"']);
  });

  it("邊界就在上限本身", () => {
    expect(shapeOf("x".repeat(24), true)).toBe(`"${"x".repeat(24)}"`);
    expect(shapeOf("x".repeat(25), true)).toBe("str(25)");
  });

  it("巢狀深度有上限，不會把整個 chara 物件搬回來", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(shapeOf(deep, true)).not.toContain("e:1");
  });
});

describe("isWsWatchReport", () => {
  it("認得三種回報", () => {
    expect(isWsWatchReport({ type: "ws-event" })).toBe(true);
    expect(isWsWatchReport({ type: "ws-watch-installed" })).toBe(true);
    expect(isWsWatchReport({ type: "ws-watch-error" })).toBe(true);
  });

  it("擋掉別人的 binding 回報", () => {
    // 同一個 binding 也收 cost-patch 的回報，分流靠這個。
    expect(isWsWatchReport({ type: "cost-patch" })).toBe(false);
    expect(isWsWatchReport(null)).toBe(false);
    expect(isWsWatchReport("ws-event")).toBe(false);
  });
});
