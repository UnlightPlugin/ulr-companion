/**
 * 好友面板的贈送次數
 *
 * 跟 `patch-lobby` / `patch-stage` 同一套：搭一個夠像的假遊戲，把
 * `buildPresentPatchScript()` 產出來的**那一串字**原封不動 `new Function`
 * 起來跑。不重寫一份等價實作 —— 那只會證明我看懂了自己寫的東西。
 *
 * 假環境照 2026-09-12 從跑著的客戶端挖出來的形狀寫：
 *
 * ```js
 *   // 面板（b）的 constructor：
 *   this.friend_max = t.add.text(180, -140, "Friends 171/200",
 *     { fontFamily: "font_light", fontSize: 10, resolution: 2, color: "black" })
 *     .setOrigin(0, 1);
 *   this.tab_name = "present" | "friend" | "request" | "search" | "none";
 *
 *   // Quest.create() 把伺服器的回覆轉發到 Friend 的事件上：
 *   x.events.emit("quest_present_code", s);   // 0 成功 … 5 今天不能再送
 *
 *   // 次數本身是伺服器送的，客戶端從來沒讀過：
 *   await socket.fetch("db_quest", id) → { …, pre_id, pre_remain }
 * ```
 *
 * 這支要抓的坑：
 *
 * 1. 面板每開一次都是新物件 —— 掛在舊物件上的東西會跟著死
 * 2. 重裝時 `quest_present_code` 的監聽會變兩份 → 送一次扣兩次
 * 3. 只有 code 0 才扣（3/4 是「根本沒送成」，次數沒被消耗）
 * 4. 開頭要切齊好友格線左緣 —— 取 friend_max 的左右鏡像會偏進格線裡面
 */

import { describe, expect, it } from "vitest";
import {
  buildPresentPatchScript,
  parsePresentStatus,
  PRESENT_SCRIPT_VERSION,
  PRESENT_STATUS_EXPRESSION,
  PRESENT_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  handlers = new Map<string, Handler[]>();
  on(name: string, fn: Handler): this {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return this;
  }
  off(name: string, fn: Handler): this {
    const list = (this.handlers.get(name) ?? []).filter((h) => h !== fn);
    this.handlers.set(name, list);
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
  count(name: string): number {
    return (this.handlers.get(name) ?? []).length;
  }
}

class FakeObject extends FakeEmitter {
  destroyed = false;
  visible = true;
  originX = 0;
  originY = 0;
  interactive = false;
  constructor(
    public type: string,
    public x: number,
    public y: number,
  ) {
    super();
  }
  setOrigin(x: number, y?: number): this {
    this.originX = x;
    this.originY = y ?? x;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setInteractive(): this {
    this.interactive = true;
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeText extends FakeObject {
  width: number;
  height = 16;
  constructor(
    x: number,
    y: number,
    public text: string,
    public style: Record<string, unknown>,
  ) {
    super("Text", x, y);
    this.width = text.length * 8;
  }
  setText(t: string): this {
    this.text = t;
    this.width = t.length * 8;
    return this;
  }
  setColor(c: string): this {
    this.style.color = c;
    return this;
  }
}

class FakeContainer extends FakeObject {
  list: FakeObject[] = [];
  constructor(x = 0, y = 0) {
    super("Container", x, y);
  }
  add(child: FakeObject): this {
    this.list.push(child);
    return this;
  }
  bringToTop(child: FakeObject): this {
    this.list = this.list.filter((o) => o !== child).concat(child);
    return this;
  }
}

/** 分頁。`refresh_tab` 每次都重建它，但**面板本身不重建**。 */
interface FakeTab {
  /** 好友格線的底圖。實測 present 分頁：`x=-232 y=-132 w=464 h=264`，origin 0。 */
  list_background: { x: number };
}

/** 好友面板。⚠ 每次 `open_panel()` 都是一個新的 —— 這正是坑 1。 */
class FakePanel extends FakeContainer {
  friend_max: FakeText;
  tab: FakeTab = { list_background: { x: -232 } };
  active = true;
  constructor(public tab_name: string) {
    super(380, 300);
    // 照抄客戶端：x=180, y=-140, origin(0,1)
    this.friend_max = new FakeText(180, -140, "Friends 171/200", {
      fontFamily: "font_light",
      fontSize: 10,
      color: "black",
    }).setOrigin(0, 1) as FakeText;
  }
}

interface FakeWindow {
  game: { scene: { keys: Record<string, unknown> } };
  lang: string;
  [key: string]: unknown;
}

interface FakeGame {
  window: FakeWindow;
  friend: { events: FakeEmitter; friend_panel: FakePanel | null; add: FakeFactory };
  /** 伺服器現在說還剩幾次。`null` = fetch 會 reject。 */
  serverRemain: number | null;
  /** `db_quest` 被問了幾次。 */
  fetches: number;
  openPanel(tab: string): FakePanel;
  closePanel(): void;
}

interface FakeFactory {
  text(x: number, y: number, t: string, style: Record<string, unknown>): FakeText;
  container(x: number, y: number): FakeContainer;
  rectangle(x: number, y: number, w: number, h: number, color: number, alpha: number): FakeObject;
}

/**
 * @param lobbyRemain 大廳那份 db_quest 快照。`null` = 沒有（玩家還沒進過大廳）。
 * @param quest `false` = Quest 場景不在（＝問不到伺服器，只能靠快照）。
 */
function makeGame(options: { lobbyRemain?: number | null; quest?: boolean } = {}): FakeGame {
  const lobbyRemain = options.lobbyRemain === undefined ? 5 : options.lobbyRemain;
  const hasQuest = options.quest !== false;

  const factory: FakeFactory = {
    text: (x, y, t, style) => new FakeText(x, y, t, { ...style }),
    container: (x, y) => new FakeContainer(x, y),
    rectangle: (x, y) => new FakeObject("Rectangle", x, y),
  };

  const game: FakeGame = {
    serverRemain: 5,
    fetches: 0,
    friend: { events: new FakeEmitter(), friend_panel: null, add: factory },
    window: null as unknown as FakeWindow,
    openPanel(tab: string) {
      // ⚠ 舊面板連同我們掛上去的東西一起 destroy —— 客戶端就是這樣。
      const old = game.friend.friend_panel;
      if (old) {
        for (const child of old.list) child.destroy();
        old.destroy();
        old.active = false;
      }
      const panel = new FakePanel(tab);
      game.friend.friend_panel = panel;
      return panel;
    },
    closePanel() {
      const old = game.friend.friend_panel;
      if (old) {
        for (const child of old.list) child.destroy();
        old.active = false;
      }
      game.friend.friend_panel = null;
    },
  };

  const quest = {
    id: "player-id",
    socket: {
      fetch(name: string, id: string) {
        if (name !== "db_quest") return Promise.reject(new Error("unexpected " + name));
        game.fetches += 1;
        if (game.serverRemain === null) return Promise.reject(new Error("斷線"));
        return Promise.resolve({ map: 5, pre_id: 3, pre_remain: game.serverRemain, id });
      },
    },
  };

  const keys: Record<string, unknown> = { Friend: game.friend };
  if (hasQuest) keys.Quest = quest;
  if (lobbyRemain !== null) keys.Lobby = { quest: { map: 5, pre_remain: lobbyRemain } };

  game.window = { game: { scene: { keys } }, lang: "tcn" };
  return game;
}

/**
 * 腳本交給 `setInterval` 的那支輪詢。**測試手動代打它，而不是用重裝假裝。**
 *
 * ⚠ 用重裝當輪詢會把一整類 bug 測不到：重裝每次都從乾淨狀態開始，而輪詢是
 * **帶著上一輪的 `st` 跑的** —— 「面板換人了要重掛」「面板關了要收掉但記著
 * 次數」全都在那個狀態差上。
 */
let poll: (() => void) | null = null;

/**
 * 把腳本丟進去跑。
 *
 * ⚠ 用 `new Function` 而不是 `eval`：跳脫錯了的話這裡會直接丟 SyntaxError，
 * 而那正是要抓的其中一個坑（腳本住在 template literal 裡）。
 */
function run(game: FakeGame, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    w: FakeWindow,
    si: (fn: () => void, ms: number) => number,
    ci: () => void,
  ) => string;
  return fn(
    game.window,
    (cb) => {
      poll = cb;
      return 1;
    },
    () => {
      poll = null;
    },
  );
}

function install(game: FakeGame): string {
  return run(game, buildPresentPatchScript());
}

/** 輪詢跑一輪（＝頁面上那 500ms 到了）。 */
function tick(): void {
  expect(poll).not.toBeNull();
  poll!();
}

/** 讓 Promise 的 then 跑完。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function status(game: FakeGame) {
  return parsePresentStatus(run(game, PRESENT_STATUS_EXPRESSION));
}

function ourText(game: FakeGame): FakeText | undefined {
  const panel = game.friend.friend_panel;
  return panel?.list.find(
    (o): o is FakeText => o instanceof FakeText && !o.destroyed && o !== panel.friend_max,
  );
}

function tooltip(game: FakeGame): FakeContainer | undefined {
  const panel = game.friend.friend_panel;
  return panel?.list.find((o): o is FakeContainer => o instanceof FakeContainer && !o.destroyed);
}

// ---------------------------------------------------------------------------

describe("好友面板的贈送次數", () => {
  it("present 分頁上畫出剩餘次數，開頭切齊好友格線左緣", async () => {
    const game = makeGame();
    game.serverRemain = 4;
    game.openPanel("present");
    install(game);
    await flush();

    const text = ourText(game);
    expect(text).toBeDefined();
    const panel = game.friend.friend_panel!;
    // 跟 friend_max 同一條基線 —— 兩行是一對。
    expect(text!.y).toBe(panel.friend_max.y);
    // ⚠ 開頭切齊格線左緣，**不是** friend_max 的左右鏡像。
    expect(text!.x).toBe(panel.tab.list_background.x);
    expect(text!.x).not.toBe(-panel.friend_max.x);
    expect(text!.originX).toBe(0);
    expect(text!.originY).toBe(1);
    // 字體照抄，不自己挑。
    expect(text!.style.fontFamily).toBe(panel.friend_max.style.fontFamily);
    expect(text!.style.fontSize).toBe(panel.friend_max.style.fontSize);
  });

  it("讀不到格線時退回量好的座標，而不是擺到面板中間", async () => {
    const game = makeGame();
    game.serverRemain = 4;
    const panel = game.openPanel("present");
    // 分頁還沒建好（refresh_tab 之前的那一瞬間）。
    panel.tab = undefined as unknown as FakeTab;
    install(game);
    await flush();

    expect(ourText(game)!.x).toBe(-232);
  });

  it("面板上只有計數那一行，沒有標點也沒有說明", async () => {
    const game = makeGame();
    game.serverRemain = 4;
    game.openPanel("present");
    install(game);
    await flush();

    const shown = ourText(game)!.text;
    expect(shown).toBe("Presents 4/5");
    expect(shown).not.toMatch(/[（）()。，、：:]/);
    // 純 ASCII —— 對照組 Friends 171/200 在每種語言也都是英文。
    expect(shown).toMatch(/^[\x20-\x7e]+$/);
  });

  it("說明只出現在 tooltip，而且預設是收起來的", async () => {
    const game = makeGame();
    game.openPanel("present");
    install(game);
    await flush();

    const tip = tooltip(game);
    expect(tip).toBeDefined();
    expect(tip!.visible).toBe(false);

    const text = ourText(game)!;
    expect(text.interactive).toBe(true);
    text.emit("pointerover");
    expect(tip!.visible).toBe(true);
    text.emit("pointerout");
    expect(tip!.visible).toBe(false);

    // 說明字**只在** tooltip 裡，面板上那一格不帶任何說明。
    const tipText = tip!.list.find((o): o is FakeText => o instanceof FakeText)!;
    expect(tipText.text).toBe("今日剩餘贈送任務次數");
    expect(text.text).not.toContain("贈送");
  });

  it("不是 present 分頁就完全不畫", async () => {
    const game = makeGame();
    game.openPanel("friend");
    install(game);
    await flush();

    expect(ourText(game)).toBeUndefined();
    expect(status(game).mounted).toBe(false);
    // ⚠ 這不是錯誤 —— UI 不該報紅。
    expect(status(game).reason).toBeNull();
  });

  it("次數取自伺服器的 pre_remain，不是自己數的", async () => {
    const game = makeGame({ lobbyRemain: 5 });
    game.serverRemain = 2;
    game.openPanel("present");
    install(game);
    await flush();

    expect(game.fetches).toBeGreaterThan(0);
    expect(ourText(game)!.text).toBe("Presents 2/5");
    expect(status(game).remain).toBe(2);
  });

  it("Quest 場景不在時用大廳那份快照墊著", async () => {
    const game = makeGame({ quest: false, lobbyRemain: 3 });
    game.openPanel("present");
    install(game);
    await flush();

    expect(game.fetches).toBe(0);
    expect(ourText(game)!.text).toBe("Presents 3/5");
    // 問不到伺服器不算錯誤 —— 快照就是拿來墊這個空檔的。
    expect(status(game).reason).toBeNull();
  });

  it("送出成功才扣，AP 不足或對方滿了都不扣", async () => {
    const game = makeGame();
    game.serverRemain = 5;
    game.openPanel("present");
    install(game);
    await flush();
    expect(ourText(game)!.text).toBe("Presents 5/5");

    // 3 = AP 不足、4 = 對方任務欄滿 —— 這一次根本沒送成。
    game.friend.events.emit("quest_present_code", 3);
    game.friend.events.emit("quest_present_code", 4);
    await flush();
    expect(ourText(game)!.text).toBe("Presents 5/5");

    // 0 = 送成了。伺服器同時也少一次。
    game.serverRemain = 4;
    game.friend.events.emit("quest_present_code", 0);
    await flush();
    expect(ourText(game)!.text).toBe("Presents 4/5");
  });

  it("伺服器說今天不能再送就直接歸零，而且變紅", async () => {
    const game = makeGame();
    game.serverRemain = 1;
    game.openPanel("present");
    install(game);
    await flush();
    expect(ourText(game)!.style.color).toBe("black");

    game.serverRemain = 0;
    game.friend.events.emit("quest_present_code", 5);
    await flush();

    expect(ourText(game)!.text).toBe("Presents 0/5");
    expect(ourText(game)!.style.color).toBe("#a01010");
  });

  it("重裝不會讓監聽變兩份（送一次只扣一次）", async () => {
    const game = makeGame();
    game.serverRemain = 5;
    game.openPanel("present");
    install(game);
    await flush();

    install(game);
    install(game);
    await flush();

    expect(game.friend.events.count("quest_present_code")).toBe(1);

    // 伺服器那邊先不動，才看得出本機扣了幾次。
    game.friend.events.emit("quest_present_code", 0);
    expect(status(game).remain).toBe(4);
  });

  it("面板重開會重新掛上去（舊的跟著舊面板一起死）", async () => {
    const game = makeGame();
    game.serverRemain = 5;
    const first = game.openPanel("present");
    install(game);
    await flush();
    const firstText = ourText(game)!;
    expect(firstText.destroyed).toBe(false);

    game.closePanel();
    game.openPanel("present");
    // ⚠ 這裡是**輪詢**發現面板換人了，不是重裝 —— 玩家不會為了看數字去重連。
    tick();
    await flush();

    expect(firstText.destroyed).toBe(true);
    expect(first.active).toBe(false);
    const second = ourText(game)!;
    expect(second).not.toBe(firstText);
    expect(second.text).toBe("Presents 5/5");
  });

  it("面板關了就收掉，但次數記著 —— 再開時不必先空一下", async () => {
    const game = makeGame({ lobbyRemain: null });
    game.serverRemain = 2;
    game.openPanel("present");
    install(game);
    await flush();
    expect(status(game).remain).toBe(2);

    game.closePanel();
    tick();
    expect(status(game).mounted).toBe(false);
    // 收掉的是畫面，不是知道的事。
    expect(status(game).remain).toBe(2);

    // ⚠ 再開時伺服器改口了（玩家在別台機器上送過）—— 以伺服器為準。
    game.serverRemain = 1;
    game.openPanel("present");
    tick();
    // 先畫記著的那個數字（不空一下），fetch 回來才改口。
    expect(ourText(game)!.text).toBe("Presents 2/5");
    await flush();
    expect(ourText(game)!.text).toBe("Presents 1/5");
  });

  it("切到別的分頁會收掉，切回 present 再出現", async () => {
    const game = makeGame();
    game.serverRemain = 5;
    const panel = game.openPanel("present");
    install(game);
    await flush();
    expect(ourText(game)).toBeDefined();

    // refresh_tab 只換 panel.tab，面板本身不重建。
    panel.tab_name = "friend";
    tick();
    expect(ourText(game)).toBeUndefined();

    panel.tab_name = "present";
    tick();
    await flush();
    expect(ourText(game)!.text).toBe("Presents 5/5");
  });

  it("伺服器給的數字比預設上限大時，分母跟著頂上去", async () => {
    const game = makeGame({ lobbyRemain: null });
    game.serverRemain = 8;
    game.openPanel("present");
    install(game);
    await flush();

    expect(ourText(game)!.text).toBe("Presents 8/8");
    expect(status(game).max).toBe(8);
  });

  it("db_quest 問不到時把原因帶回來，但不畫假數字", async () => {
    const game = makeGame({ lobbyRemain: null });
    game.serverRemain = null;
    game.openPanel("present");
    install(game);
    await flush();

    expect(status(game).remain).toBeNull();
    expect(status(game).reason).toContain("db_quest");
    expect(ourText(game)!.text).toBe("");
  });

  it("狀態帶著版本號，而且沒裝的時候說得出來", () => {
    const game = makeGame();
    expect(status(game).installed).toBe(false);

    game.openPanel("present");
    install(game);
    expect(status(game).installed).toBe(true);
    expect(status(game).version).toBe(PRESENT_SCRIPT_VERSION);
  });

  it("拆得乾淨：物件、監聽、旗標都不留", async () => {
    const game = makeGame();
    game.openPanel("present");
    install(game);
    await flush();
    const text = ourText(game)!;

    expect(run(game, PRESENT_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(text.destroyed).toBe(true);
    expect(game.friend.events.count("quest_present_code")).toBe(0);
    expect(game.window.__ulrPresent).toBeUndefined();
    expect(run(game, PRESENT_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("每種語言都一樣是英文 —— 跟右邊的 Friends 同一種東西", async () => {
    for (const lang of ["ja", "en", "kr", "scn", "tcn"] as const) {
      const game = makeGame();
      game.window.lang = lang;
      game.serverRemain = 4;
      game.openPanel("present");
      install(game);
      await flush();
      // ⚠ 對照組 friend_max 在每種語言都是英文（客戶端寫死的），跟著它走。
      expect(ourText(game)!.text).toBe("Presents 4/5");
    }
  });

  it("tooltip 才跟著語言走", async () => {
    for (const [lang, expected] of [
      ["ja", "本日残りのクエスト送信回数"],
      ["en", "Quest gifts left today"],
      ["kr", "오늘 남은 퀘스트 전송 횟수"],
      ["scn", "今日剩余赠送任务次数"],
      ["tcn", "今日剩餘贈送任務次數"],
    ] as const) {
      const game = makeGame();
      game.window.lang = lang;
      game.openPanel("present");
      install(game);
      await flush();
      const tipText = tooltip(game)!.list.find((o): o is FakeText => o instanceof FakeText)!;
      expect(tipText.text).toBe(expected);
    }
  });

  it("讀不懂的回應當成沒裝，原文帶在 reason 裡", () => {
    const parsed = parsePresentStatus("<!doctype html>");
    expect(parsed.installed).toBe(false);
    expect(parsed.reason).toContain("doctype");
  });
});
