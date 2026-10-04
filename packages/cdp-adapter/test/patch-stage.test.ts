/**
 * 隱藏地圖補丁
 *
 * 這一支測的是**真的會被丟進遊戲跑的那段字串**：測試裡搭一個假的遊戲環境
 * （Match 場景類別、JSON 快取裡的 MatchUITexts、rexUI 的 dropDownList），把
 * `buildHiddenStageScript()` 產出來的腳本原封不動 `new Function` 起來跑。
 *
 * ⚠ **不要改成「重寫一份等價的實作再測」** —— 那樣只證明我看懂了自己寫的東西。
 * 這支補丁的坑都在「跟遊戲真正的呼叫順序對不對得上」：
 *
 * 1. 選單是每次開對話框時從**快取裡那份陣列**現建的，選了哪一列就直接送那一列的 `value`
 * 2. `preload()` 可能把那份陣列整個換掉（換語言、快取被清），只推一次會消失
 *
 * 假環境是照 2026-09-27 從客戶端挖出來的原始碼寫的（2026-09-23 改版後），形狀與
 * 呼叫順序都對齊。
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildHiddenStageScript,
  HIDDEN_STAGES,
  HIDDEN_STAGE_STATUS_EXPRESSION,
  HIDDEN_STAGE_UNINSTALL_EXPRESSION,
  InvalidHiddenStageError,
  parseHiddenStageStatus,
} from "@ulr/cdp-adapter";
import type { HiddenStage, HiddenStageStatus } from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

interface Option {
  text: string;
  value: number;
}

/** rexUI 的 dropDownList：建的那一刻把 options 畫成一列一列。 */
interface FakeDropdown {
  rows: Option[];
  /** 玩家點了某一列 → `f.value`，就是 `create_room` 送出去的 `stage`。 */
  pick(text: string): number | undefined;
}

interface FakeScene {
  cache: { json: FakeJsonCache };
  create_stage_option(x: number, y: number): FakeDropdown;
  /** 模擬 `preload()` 從伺服器重載 MatchUITexts —— 換成一份全新的陣列。 */
  reloadTexts(): void;
}

interface FakeJsonCache {
  get(key: string): unknown;
}

interface FakeWindow {
  game: { scene: { keys: Record<string, FakeScene> }; cache: { json: FakeJsonCache } };
  lang: string;
  [key: string]: unknown;
}

/** 官方那 11 項，照抄客戶端的 `MatchUITexts.room_config.stage.option`（tcn）。 */
function officialOptions(): Option[] {
  return [
    { text: "雷德貝魯格城", value: 0 },
    { text: "誘惑森林", value: 1 },
    { text: "垃圾之街", value: 2 },
    { text: "冰封湖畔", value: 3 },
    { text: "人魂墓地", value: 4 },
    { text: "盡頭之村", value: 5 },
    { text: "風暴荒野", value: 6 },
    { text: "峰亥盧遺跡", value: 7 },
    { text: "魔都羅占布爾克", value: 8 },
    { text: "瘋狂山脈", value: 9 },
    { text: "隨機", value: 999 },
  ];
}

interface FakeGame {
  window: FakeWindow;
  scene: FakeScene;
  /** 目前快取裡那份（活的）選項陣列。 */
  options(): Option[];
}

/**
 * 搭一個夠像的遊戲。
 *
 * @param present `false` = Match 場景還沒載進來（＝玩家還在標題畫面）。
 * @param textsLoaded `false` = 還沒進過 Match，快取裡沒有 MatchUITexts。
 */
function makeGame(present = true, textsLoaded = true): FakeGame {
  const store = new Map<string, unknown>();
  const load = () => {
    store.set("MatchUITexts", {
      room_config: { stage: { label: "對戰地點", option: officialOptions() } },
    });
  };
  if (textsLoaded) load();
  const json: FakeJsonCache = { get: (k) => store.get(k) };

  class Match {
    // Phaser：scene.cache 就是 game.cache
    cache = { json };

    /** 照抄客戶端：每次開對話框都從快取現拿陣列，選哪一列就送哪一列的 value。 */
    create_stage_option(_x: number, _y: number): FakeDropdown {
      const i = this.cache.json.get("MatchUITexts") as {
        room_config: { stage: { option: Option[] } };
      };
      const rows = i.room_config.stage.option.map((o) => ({ text: o.text, value: o.value }));
      return {
        rows,
        pick: (text) => rows.find((r) => r.text === text)?.value,
      };
    }

    reloadTexts(): void {
      load();
    }
  }

  const scene = new Match() as unknown as FakeScene;
  const window = {
    game: { scene: { keys: present ? { Match: scene } : {} }, cache: { json } },
    lang: "tcn",
  } as FakeWindow;

  const options = () =>
    (store.get("MatchUITexts") as { room_config: { stage: { option: Option[] } } }).room_config
      .stage.option;

  return { window, scene, options };
}

/** 把腳本丟進假 window 跑，回傳它報的狀態。 */
function run(game: FakeGame, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", `return ${expression};`) as (w: FakeWindow) => string;
  return fn(game.window);
}

function install(
  game: FakeGame,
  stages: readonly HiddenStage[] = HIDDEN_STAGES,
): HiddenStageStatus {
  return parseHiddenStageStatus(run(game, buildHiddenStageScript({ stages })));
}

function status(game: FakeGame): HiddenStageStatus {
  return parseHiddenStageStatus(run(game, HIDDEN_STAGE_STATUS_EXPRESSION));
}

const open = (game: FakeGame): FakeDropdown => game.scene.create_stage_option(0, 0);
const texts = (d: FakeDropdown): string[] => d.rows.map((r) => r.text);
const HIDDEN_NAMES = HIDDEN_STAGES.map((s) => s.name);

// ---------------------------------------------------------------------------

describe("改版後的代號", () => {
  it("是 011〜014 —— 010 只是雷德貝魯格城的別名，不放", () => {
    expect(HIDDEN_STAGES.map((s) => s.value)).toEqual(["011", "012", "013", "014"]);
  });
});

describe("裝上去之後，遊戲自己的開房選單多四張", () => {
  it("選單從 11 列變 15 列，官方那 11 列一個都沒動到", () => {
    const game = makeGame();
    const st = install(game);

    expect(st.installed).toBe(true);
    expect(st.dropdownPatched).toBe(true);
    expect(st.added).toEqual(["011", "012", "013", "014"]);

    const d = open(game);
    expect(d.rows).toHaveLength(15);
    expect(d.rows.slice(0, 11)).toEqual(officialOptions());
    expect(texts(d).slice(11)).toEqual(HIDDEN_NAMES);
  });

  it("⚠⚠ 選了隱藏地圖，送出去的 stage 是數字代號", () => {
    // 改版後選單的 value 是數字（0〜9、隨機 999），create_room 原封不動送出去。
    // 字串 "011" 送出去就跟官方的格式不一樣了。
    const game = makeGame();
    install(game);
    const d = open(game);

    expect(d.pick("魔女山谷")).toBe(11);
    expect(d.pick("聖域的凱旋門")).toBe(14);
    // 官方那幾張仍然正確
    expect(d.pick("隨機")).toBe(999);
    expect(d.pick("雷德貝魯格城")).toBe(0);
  });

  it("開很多次對話框也不會一直加", () => {
    const game = makeGame();
    install(game);
    open(game);
    open(game);
    expect(open(game).rows).toHaveLength(15);
  });

  it("⚠ 還沒進過 Match（快取裡沒有 MatchUITexts）也裝得上，開對話框時補", () => {
    const game = makeGame(true, false);
    const st = install(game);
    expect(st.installed).toBe(true);
    expect(st.added).toEqual(["011", "012", "013", "014"]);

    game.scene.reloadTexts(); // 玩家進了對戰大廳
    expect(open(game).rows).toHaveLength(15);
  });

  it("⚠⚠ 遊戲把 MatchUITexts 整份換掉（換語言、快取被清）之後，下次開對話框自己補回來", () => {
    const game = makeGame();
    install(game);
    game.scene.reloadTexts();
    expect(game.options()).toHaveLength(11);

    const d = open(game);
    expect(d.rows).toHaveLength(15);
    expect(d.pick("白魔的圓環石陣")).toBe(13);
  });
});

describe("重裝", () => {
  it("裝兩次不會變成 19 列", () => {
    const game = makeGame();
    install(game);
    const st = install(game);
    expect(game.options()).toHaveLength(15);
    expect(st.added).toEqual(["011", "012", "013", "014"]);
  });

  it("重裝之後 create_stage_option 只包一層（不會疊補丁）", () => {
    const game = makeGame();
    const orig = Object.getPrototypeOf(game.scene).create_stage_option;
    install(game);
    install(game);
    install(game);
    expect(Object.getPrototypeOf(game.scene).__ulrOrigStageOption).toBe(orig);
    expect(open(game).rows).toHaveLength(15);
  });
});

describe("拆掉", () => {
  it("選單回官方那 11 列，create_stage_option 還原", () => {
    const game = makeGame();
    const orig = Object.getPrototypeOf(game.scene).create_stage_option;
    install(game);
    open(game);

    expect(run(game, HIDDEN_STAGE_UNINSTALL_EXPRESSION)).toBe("uninstalled:4");
    expect(game.options()).toEqual(officialOptions());
    expect(Object.getPrototypeOf(game.scene).create_stage_option).toBe(orig);
    expect(Object.getPrototypeOf(game.scene).__ulrOrigStageOption).toBeUndefined();

    const d = open(game);
    expect(d.rows).toHaveLength(11);
    expect(status(game).installed).toBe(false);
  });

  it("沒裝過就回 not-installed，不會爆", () => {
    const game = makeGame();
    expect(run(game, HIDDEN_STAGE_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });
});

describe("狀態", () => {
  it("補丁被換掉了就照實說沒裝（例如舊版腳本把它蓋掉）", () => {
    const game = makeGame();
    install(game);
    const proto = Object.getPrototypeOf(game.scene);
    proto.create_stage_option = proto.__ulrOrigStageOption;
    delete proto.__ulrOrigStageOption;

    const st = status(game);
    expect(st.installed).toBe(false);
    expect(st.reason).toContain("重新啟用");
  });

  it("陣列被換掉、還沒開對話框時，報的是等下會補上的那幾張，不是 0 張", () => {
    const game = makeGame();
    install(game);
    game.scene.reloadTexts();
    const st = status(game);
    expect(st.installed).toBe(true);
    expect(st.added).toEqual(["011", "012", "013", "014"]);
    expect(st.reason).toBeNull();
  });
});

describe("遊戲還沒載到對戰大廳", () => {
  it("⚠ 不是錯誤，是等 —— 「先開插件再開遊戲」才是玩家實際的順序", () => {
    const game = makeGame(false);
    const st = install(game);
    expect(st.installed).toBe(false);
    expect(st.waiting).toBe(true);
    expect(st.reason).toContain("對戰大廳");
    expect(status(game).waiting).toBe(true);
  });

  it("大廳出現之後自己補上，不必玩家做任何事", () => {
    vi.useFakeTimers();
    try {
      const game = makeGame(false);
      expect(install(game).installed).toBe(false);

      // 玩家登入，Match 場景載進來了
      game.window.game.scene.keys["Match"] = game.scene;
      vi.advanceTimersByTime(1000);

      const st = status(game);
      expect(st.installed).toBe(true);
      expect(st.added).toEqual(["011", "012", "013", "014"]);
      expect(st.waiting).toBe(false);
      expect(open(game).rows).toHaveLength(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⚠ 關掉之後那支等待中的 timer 一定要停 —— 否則進大廳時地圖會自己冒出來", () => {
    vi.useFakeTimers();
    try {
      const game = makeGame(false);
      install(game);
      run(game, HIDDEN_STAGE_UNINSTALL_EXPRESSION);

      game.window.game.scene.keys["Match"] = game.scene;
      vi.advanceTimersByTime(5000);

      expect(open(game).rows).toHaveLength(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重裝會停掉上一支 timer，不會兩支一起跑", () => {
    vi.useFakeTimers();
    try {
      const game = makeGame(false);
      install(game);
      install(game);

      game.window.game.scene.keys["Match"] = game.scene;
      vi.advanceTimersByTime(5000);

      // 兩支都跑的話 __ulrOrigStageOption 會是第一層包裝，而不是原版
      expect(open(game).rows).toHaveLength(15);
      expect(run(game, HIDDEN_STAGE_UNINSTALL_EXPRESSION)).toBe("uninstalled:4");
      expect(open(game).rows).toHaveLength(11);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("撞名與撞代號", () => {
  it("代號已經在官方清單裡就不加（官方哪天把它放進選單）", () => {
    const game = makeGame();
    const st = install(game, [{ value: "009", name: "另一個名字" }]);
    expect(st.added).toEqual([]);
    expect(open(game).rows).toHaveLength(11);
  });

  it("名稱跟官方的撞在一起也不加 —— 同名兩列玩家分不出來", () => {
    const game = makeGame();
    const st = install(game, [{ value: "011", name: "隨機" }]);
    expect(st.added).toEqual([]);
    expect(open(game).pick("隨機")).toBe(999);
  });
});

describe("參數檢查", () => {
  it("代號一定要是 3 位數字", () => {
    expect(() => buildHiddenStageScript({ stages: [{ value: "11", name: "x" }] })).toThrow(
      InvalidHiddenStageError,
    );
    expect(() => buildHiddenStageScript({ stages: [{ value: "abc", name: "x" }] })).toThrow(
      InvalidHiddenStageError,
    );
  });

  it("名稱不能是空的（那是選單上唯一看得到的東西）", () => {
    expect(() => buildHiddenStageScript({ stages: [{ value: "011", name: "  " }] })).toThrow(
      InvalidHiddenStageError,
    );
  });

  it("代號不能重複", () => {
    expect(() =>
      buildHiddenStageScript({
        stages: [
          { value: "011", name: "a" },
          { value: "011", name: "b" },
        ],
      }),
    ).toThrow(InvalidHiddenStageError);
  });

  it("地圖名稱是資料，不會被當成程式碼跑（§12）", () => {
    const game = makeGame();
    const evil = `"); window.pwned = true; ("`;
    install(game, [{ value: "011", name: evil }]);
    expect(game.window["pwned"]).toBeUndefined();
    expect(game.options().at(-1)?.text).toBe(evil);
  });
});

describe("parseHiddenStageStatus", () => {
  it("頁面回垃圾就當成沒裝上，不拋例外", () => {
    expect(parseHiddenStageStatus("not json").installed).toBe(false);
    expect(parseHiddenStageStatus('{"installed":true}').installed).toBe(false);
    expect(parseHiddenStageStatus("null").installed).toBe(false);
  });
});
