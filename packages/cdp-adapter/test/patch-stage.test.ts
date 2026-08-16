/**
 * 隱藏地圖補丁
 *
 * 這一支測的是**真的會被丟進遊戲跑的那段字串**：測試裡搭一個假的遊戲環境
 * （Match 場景類別、開房對話框、rexUI 的 sizer 與 label），把
 * `buildHiddenStageScript()` 產出來的腳本原封不動 `new Function` 起來跑。
 *
 * ⚠ **不要改成「重寫一份等價的實作再測」** —— 那樣只證明我看懂了自己寫的東西。
 * 這支補丁的每一個坑都在「跟遊戲真正的呼叫順序對不對得上」，重寫就全測不到：
 *
 * 1. 對話框那個類別在模組外拿不到，只能在 `add.existing` 那一瞬間攔
 * 2. `create_stage_child` 的迴圈**寫死 11**，光把地圖加進 `STAGES` 沒有用
 * 3. 選單選了哪一列是拿**名稱**回查代號的，兩邊少一邊就會送出 `undefined`
 *
 * 假環境是照 2026-08-15 從客戶端挖出來的原始碼寫的，形狀與呼叫順序都對齊。
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildHiddenStageScript,
  HIDDEN_STAGE_STATUS_EXPRESSION,
  HIDDEN_STAGE_UNINSTALL_EXPRESSION,
  HIDDEN_STAGES,
  InvalidHiddenStageError,
  parseHiddenStageStatus,
  STAGES,
} from "@ulr/cdp-adapter";
import type { HiddenStage, HiddenStageStatus } from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

interface FakeLabel {
  name: string;
  fontSize: number;
  /**
   * 底圖與文字在 display list 上的位置。
   *
   * ⚠ 這兩個數字是這支測試裡**唯一抓得到「那四列是白的」那個 bug** 的東西。
   * 兩者都直接進場景的 display list（`parentContainer` 是 null，實測過），
   * 而 display list 是**後建的畫在上面** —— 底圖比文字晚建，字就被白色底圖
   * 蓋掉。物件的其他每一個欄位都仍然完全正常。
   */
  bgSeq: number;
  textSeq: number;
}

interface FakeSizer {
  children: FakeLabel[];
  add(child: FakeLabel, cfg: unknown): FakeSizer;
}

interface FakeDialog {
  scene: FakeScene;
  stage: string | undefined;
  menu: FakeSizer;
  /** 模擬 `stage_dropdown.on("child.down")`：拿**名稱**回查代號。 */
  pick(name: string): void;
  create_stage_child(): FakeSizer;
}

interface FakeScene {
  add: FakeFactory;
  rexUI: {
    add: { label: (cfg: never) => FakeLabel; roundRectangle: () => object; sizer: () => FakeSizer };
  };
  room_make(): Promise<FakeDialog>;
}

interface FakeFactory {
  existing(obj: object): object;
  text(x: number, y: number, t: string, style: { fontSize: number }): unknown;
}

interface FakeWindow {
  game: { scene: { keys: Record<string, FakeScene> } };
  lang: string;
  [key: string]: unknown;
}

/** 官方那 11 項，形狀照抄客戶端（`{name, value}`，**name 在前**）。 */
function officialStages(): { name: string; value: string }[] {
  return STAGES.map((s) => ({ name: s.name, value: s.value }));
}

interface FakeGame {
  window: FakeWindow;
  Match: { new (): FakeScene; STAGES: Record<string, { name: string; value: string }[]> };
  scene: FakeScene;
  /** 每一次 `room_make()` 建出來的對話框。 */
  dialogs: FakeDialog[];
  /** `add.existing` 被叫過幾次（還原檢查要用）。 */
  factoryProto: FakeFactory;
}

/**
 * 搭一個夠像的遊戲。
 *
 * @param present `false` = Match 場景還沒載進來（＝玩家還在標題畫面）。
 */
function makeGame(present = true): FakeGame {
  const dialogs: FakeDialog[] = [];

  // display list 的位置。每建一個物件就 +1 —— 大的畫在上面。
  let seq = 0;

  const rexUI = {
    add: {
      roundRectangle: () => ({ seq: ++seq }),
      label: (cfg: {
        name: string;
        background: { seq: number };
        text: { seq: number; style: { fontSize: number } };
      }): FakeLabel => ({
        name: cfg.name,
        fontSize: cfg.text.style.fontSize,
        bgSeq: cfg.background.seq,
        textSeq: cfg.text.seq,
      }),
      sizer: (): FakeSizer => {
        const children: FakeLabel[] = [];
        return {
          children,
          add(child) {
            children.push(child);
            return this;
          },
        };
      },
    },
  };

  // ⚠ `existing` 放在 **prototype** 上，跟真的 Phaser 一樣（實測：
  // `hasOwnProperty(scene.add, "existing")` 是 false）。補丁換的是實例上的欄位，
  // 用完要 delete 掉才算真的還原 —— 放在實例上就測不到那個分別。
  const factoryProto: FakeFactory = {
    existing(obj: object) {
      return obj;
    },
    text(_x: number, _y: number, t: string, style: { fontSize: number }) {
      const o = {
        content: t,
        style,
        seq: ++seq,
        // 假設一個字 13px：名稱越長越寬，才測得到「太長要縮字級」那段。
        get width() {
          return t.length * o.style.fontSize;
        },
        setResolution() {
          return o;
        },
        setFontSize(n: number) {
          o.style.fontSize = n;
          return o;
        },
      };
      return o;
    },
  };

  class Match {
    static STAGES: Record<string, { name: string; value: string }[]> = {
      tcn: officialStages(),
      ja: officialStages(),
    };

    add = Object.create(factoryProto) as FakeFactory;
    rexUI = rexUI;

    /**
     * 照抄客戶端的呼叫順序：對話框是在 `new Promise(...)` 的 executor 裡建的，
     * 也就是**第一個 await 之前**（補丁能安全還原 `add.existing` 全靠這件事）。
     */
    async room_make(): Promise<FakeDialog> {
      const dialog = await new Promise<FakeDialog>((resolve) => {
        resolve(new Dialog(this as unknown as FakeScene));
      });
      dialogs.push(dialog);
      return dialog;
    }
  }

  class Dialog {
    scene: FakeScene;
    stage: string | undefined;
    menu: FakeSizer;

    constructor(scene: FakeScene) {
      this.scene = scene;
      // ① 對話框把自己加進場景 —— 補丁就是攔這裡
      scene.add.existing(this);
      this.stage = Match.STAGES[window.lang]?.[0]?.value;
      // ③ 選單在同一次 constructor 裡就畫好了
      this.menu = this.create_stage_child();
    }

    /**
     * ⚠ 迴圈**寫死 11**，跟客戶端一樣。
     *
     * ⚠ 物件字面值的求值順序也要跟客戶端一樣：**background 在前、text 在後**。
     * 那個順序就是畫面上誰蓋住誰，寫反了字會被白底蓋掉。
     */
    create_stage_child(): FakeSizer {
      const sizer = this.scene.rexUI.add.sizer();
      for (let i = 0; i < 11; i++) {
        const name = Match.STAGES[window.lang]?.[i]?.name ?? "";
        sizer.add(
          this.scene.rexUI.add.label({
            background: this.scene.rexUI.add.roundRectangle(),
            text: this.scene.add.text(0, 0, name, { fontSize: 13 }),
            name,
          } as never) as FakeLabel,
          { expand: true },
        );
      }
      return sizer;
    }

    /** ② 選了某一列：拿**名稱**回查代號。 */
    pick(name: string): void {
      this.stage = Match.STAGES[window.lang]?.find((s) => s.name === name)?.value;
    }
  }

  const scene = new Match() as unknown as FakeScene;
  const window = {
    game: { scene: { keys: present ? { Match: scene } : {} } },
    lang: "tcn",
  } as FakeWindow;

  return { window, Match: Match as never, scene, dialogs, factoryProto };
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

const names = (d: FakeDialog): string[] => d.menu.children.map((c) => c.name);

// ---------------------------------------------------------------------------

describe("裝上去之後，遊戲自己的開房選單多四張", () => {
  it("STAGES 從 11 變 15，官方那 11 項一個都沒動到", () => {
    const game = makeGame();
    const before = game.Match.STAGES["tcn"]!.map((s) => s.value);
    const st = install(game);

    expect(st.installed).toBe(true);
    expect(st.added).toEqual(["010", "011", "012", "013"]);
    const after = game.Match.STAGES["tcn"]!;
    expect(after).toHaveLength(15);
    expect(after.slice(0, 11).map((s) => s.value)).toEqual(before);
    expect(after.slice(11).map((s) => s.name)).toEqual([
      "魔女山谷",
      "白魔的圓環石陣",
      "烏波斯的黑湖",
      "聖域的凱旋門",
    ]);
  });

  it("⚠ 選單要等玩家開一次對話框 —— 裝好的當下還是 false，不能報成生效中", () => {
    const game = makeGame();
    expect(install(game).dropdownPatched).toBe(false);
    expect(status(game).dropdownPatched).toBe(false);
  });

  it("開一次對話框，選單就是 15 列（而且是第一次就有，不必開兩次）", async () => {
    const game = makeGame();
    install(game);

    const dialog = await game.scene.room_make();
    expect(names(dialog)).toHaveLength(15);
    expect(names(dialog).slice(11)).toEqual([
      "魔女山谷",
      "白魔的圓環石陣",
      "烏波斯的黑湖",
      "聖域的凱旋門",
    ]);
    expect(status(game).dropdownPatched).toBe(true);
  });

  it("⚠⚠ 選了隱藏地圖之後 stage 是代號，不是 undefined", async () => {
    // 這是整支補丁最重要的一條。遊戲是拿**名稱**回查代號的，只補選單不補
    // STAGES 的話這裡會是 undefined，而伺服器對那個的回應是 fail:20 ——
    // 症狀會被誤讀成「AP 不足」。
    const game = makeGame();
    install(game);
    const dialog = await game.scene.room_make();

    dialog.pick("魔女山谷");
    expect(dialog.stage).toBe("010");
    dialog.pick("聖域的凱旋門");
    expect(dialog.stage).toBe("013");
    // 官方那幾張仍然正確
    dialog.pick("隨機");
    expect(dialog.stage).toBe("014");
    dialog.pick("雷德貝魯格城");
    expect(dialog.stage).toBe("000");
  });

  it("⚠⚠ 文字要比底圖晚建，否則白色底圖會蓋住字（實測踩過：那四列變成純白）", async () => {
    // 兩個都直接進場景的 display list，**後建的畫在上面**。原版是靠物件字面值
    // 「background 寫在 text 前面」剛好對；我們為了量寬度得先把 text 存進變數，
    // 一不小心就反過來 —— 而反過來時**物件的每一個欄位都還是正常的**，
    // 只有 display list 的索引差一位。所以只能從順序測。
    const game = makeGame();
    install(game);
    const dialog = await game.scene.room_make();

    const wrong = dialog.menu.children
      .map((c, i) => ({ i, name: c.name, ok: c.textSeq > c.bgSeq }))
      .filter((r) => !r.ok);
    expect(wrong).toEqual([]);
  });

  it("名稱太長會自己縮字級（原版的 fit_single 在模組外拿不到）", async () => {
    const game = makeGame();
    // 一個字 13px × 20 字 = 260px，遠超過 141px 的欄寬
    install(game, [{ value: "010", name: "非常非常非常非常非常非常非常非常非常長的名字" }]);
    const dialog = await game.scene.room_make();

    const extra = dialog.menu.children[11]!;
    expect(extra.fontSize).toBeLessThan(13);
    expect(extra.fontSize).toBeGreaterThanOrEqual(9);
  });

  it("攔完就把 add.existing 還回去 —— 遊戲其餘的 add.existing 沒有被碰過", async () => {
    const game = makeGame();
    install(game);
    await game.scene.room_make();

    // 還原的定義是「實例上那個欄位不見了」，不是「值長得一樣」。
    expect(Object.prototype.hasOwnProperty.call(game.scene.add, "existing")).toBe(false);
    expect(game.scene.add.existing).toBe(game.factoryProto.existing);
  });
});

describe("重裝", () => {
  it("裝兩次不會變成 19 張", () => {
    const game = makeGame();
    install(game);
    const st = install(game);
    expect(game.Match.STAGES["tcn"]).toHaveLength(15);
    expect(st.added).toEqual(["010", "011", "012", "013"]);
  });

  it("重裝之後 room_make 只包一層（不會疊補丁）", async () => {
    const game = makeGame();
    install(game);
    install(game);
    install(game);
    const dialog = await game.scene.room_make();
    // 疊三層的話這裡會是 15 + 4 + 4
    expect(names(dialog)).toHaveLength(15);
  });

  it("⚠ 重裝不會把已經攔到的對話框補丁弄丟（重連時每次都會重裝）", async () => {
    const game = makeGame();
    install(game);
    await game.scene.room_make();
    expect(status(game).dropdownPatched).toBe(true);

    // 重連 → 重裝。玩家沒有再開一次對話框。
    const again = install(game);
    expect(again.dropdownPatched).toBe(true);

    const dialog = await game.scene.room_make();
    expect(names(dialog)).toHaveLength(15);
    dialog.pick("烏波斯的黑湖");
    expect(dialog.stage).toBe("012");
  });
});

describe("拆掉", () => {
  it("選單回官方那 11 項，room_make 與 create_stage_child 都還原", async () => {
    const game = makeGame();
    const origRoomMake = Object.getPrototypeOf(game.scene).room_make;
    install(game);
    await game.scene.room_make();

    expect(run(game, HIDDEN_STAGE_UNINSTALL_EXPRESSION)).toMatch(/^uninstalled:/);
    expect(game.Match.STAGES["tcn"]).toHaveLength(11);
    expect(Object.getPrototypeOf(game.scene).room_make).toBe(origRoomMake);

    const dialog = await game.scene.room_make();
    expect(names(dialog)).toHaveLength(11);
    dialog.pick("隨機");
    expect(dialog.stage).toBe("014");
    expect(status(game).installed).toBe(false);
  });

  it("每一種語言都掃過 —— 換過語言的話兩份清單都要清乾淨", () => {
    const game = makeGame();
    install(game);
    // 玩家換成日文之後又啟用一次
    game.window.lang = "ja";
    install(game);
    expect(game.Match.STAGES["tcn"]).toHaveLength(15);
    expect(game.Match.STAGES["ja"]).toHaveLength(15);

    run(game, HIDDEN_STAGE_UNINSTALL_EXPRESSION);
    expect(game.Match.STAGES["tcn"]).toHaveLength(11);
    expect(game.Match.STAGES["ja"]).toHaveLength(11);
  });

  it("沒裝過就回 not-installed，不會爆", () => {
    const game = makeGame();
    expect(run(game, HIDDEN_STAGE_UNINSTALL_EXPRESSION)).toBe("not-installed");
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
      expect(st.added).toEqual(["010", "011", "012", "013"]);
      expect(st.waiting).toBe(false);
      expect(game.Match.STAGES["tcn"]).toHaveLength(15);
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

      expect(game.Match.STAGES["tcn"]).toHaveLength(11);
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

      // 兩支都跑的話會加成 19 張
      expect(game.Match.STAGES["tcn"]).toHaveLength(15);
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
    expect(game.Match.STAGES["tcn"]).toHaveLength(11);
  });

  it("⚠ 名稱跟官方的撞在一起也不加 —— 撞名會讓官方那張選出錯的代號", async () => {
    const game = makeGame();
    const st = install(game, [{ value: "010", name: "隨機" }]);
    expect(st.added).toEqual([]);

    const dialog = await game.scene.room_make();
    dialog.pick("隨機");
    expect(dialog.stage).toBe("014");
  });
});

describe("參數檢查", () => {
  it("代號一定要是 3 位數字 —— 送錯格式伺服器回 fail:20", () => {
    expect(() => buildHiddenStageScript({ stages: [{ value: "10", name: "x" }] })).toThrow(
      InvalidHiddenStageError,
    );
    expect(() => buildHiddenStageScript({ stages: [{ value: "abc", name: "x" }] })).toThrow(
      InvalidHiddenStageError,
    );
  });

  it("名稱不能是空的（那是選單上唯一看得到的東西）", () => {
    expect(() => buildHiddenStageScript({ stages: [{ value: "010", name: "  " }] })).toThrow(
      InvalidHiddenStageError,
    );
  });

  it("代號不能重複", () => {
    expect(() =>
      buildHiddenStageScript({
        stages: [
          { value: "010", name: "a" },
          { value: "010", name: "b" },
        ],
      }),
    ).toThrow(InvalidHiddenStageError);
  });

  it("地圖名稱是資料，不會被當成程式碼跑（§12）", () => {
    const game = makeGame();
    const evil = `"); window.pwned = true; ("`;
    install(game, [{ value: "010", name: evil }]);
    expect(game.window["pwned"]).toBeUndefined();
    expect(game.Match.STAGES["tcn"]!.at(-1)?.name).toBe(evil);
  });
});

describe("parseHiddenStageStatus", () => {
  it("頁面回垃圾就當成沒裝上，不拋例外", () => {
    expect(parseHiddenStageStatus("not json").installed).toBe(false);
    expect(parseHiddenStageStatus('{"installed":true}').installed).toBe(false);
    expect(parseHiddenStageStatus("null").installed).toBe(false);
  });
});
