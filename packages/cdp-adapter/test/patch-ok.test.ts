import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OK_BUTTON, WS_CLIENT } from "../src/constants.js";
import type { OkPatchReport } from "../src/patch-ok.js";
import {
  buildOkPatchScript,
  isOkPatchReport,
  OK_PATCH_GLOBAL,
  READY_TINT_AMBER,
} from "../src/patch-ok.js";

const script = buildOkPatchScript({ bindingName: "__test_binding" });

/**
 * 把注入腳本裡的設定解出來。
 *
 * `embedJson` 是雙層的（`JSON.stringify(JSON.stringify(x))`），所以腳本裡長的是
 * `JSON.parse("{\"readyTint\":null}")` —— 直接對腳本字串比對會抓不到跳脫過的
 * 引號，而且會安靜地失敗成「找不到 = 測試紅」或更糟的「找到 = 假綠」。
 */
function configOf(src: string): { readyTint: number | null; localDeadlineSeconds: number } {
  const m = /var CFG = JSON\.parse\((".*?")\);/.exec(src);
  if (m?.[1] === undefined) throw new Error("腳本裡找不到 CFG —— 嵌入方式改了？");
  return JSON.parse(JSON.parse(m[1]) as string) as ReturnType<typeof configOf>;
}

/** `release()` 的函式本體。好幾條測試要在裡面找東西。 */
function releaseBody(): string {
  const body = script.slice(script.indexOf("release: function (by)"));
  return body.slice(0, body.indexOf("cancel:"));
}

describe("buildOkPatchScript", () => {
  it("產生的是語法正確的 JS", () => {
    expect(() => new Script(script)).not.toThrow();
  });

  it("⚠ 一定要有失效保護", () => {
    // 這是整個檔案存在的理由之一。壓著 I_am_ok 期間若 CDP 斷線或 Node 當掉，
    // 玩家會逾時棄權 —— 不可逆，而且是我們造成的。
    expect(script).toContain('state.release("failsafe")');
    expect(script).toContain("setTimeout");
  });

  it("重放是原封不動 apply，不重建參數", () => {
    // 插件不需要知道 I_am_ok 的協定長什麼樣，改版換參數也不會送錯。
    expect(script).toContain("state.originalEmit.apply(h.self, h.args)");
    // 不可以出現任何自己組參數的痕跡
    expect(script).not.toContain('emit("I_am_ok"');
  });

  it("⚠ 已經壓著一個時，第二次按**不能**直接送出", () => {
    // 直接送出的話玩家就永遠取消不了，等於這個功能不存在。
    // 正確做法是回報給仲裁，由它判成取消準備。
    expect(script).toContain('report({ type: "ok-pressed-again", at: Date.now() });');
    // 而且不可以疊第二個 held —— 釋放順序會亂掉。
    expect(script).toContain("if (state.held) {");
  });

  it("⚠ 釘 frame 的做法是把遊戲的 hover handler 收起來，不是跟它搶", () => {
    // 遊戲有 .on("pointerout", () => setTexture("ok", 0))。因為我們保持
    // setInteractive() 讓玩家能取消，滑鼠一移開 frame 就被改回普通的 OK。
    //
    // 「再掛一組搶」的版本會在漏拆時**讓 hover 直接顯示成準備狀態**
    // —— 玩家根本沒按（2026-08-02 實測）。收起來的版本漏拆只是 hover 沒反應。
    expect(script).toContain("pinFrame:");
    expect(script).toContain('ok.off("pointerover")');
    expect(script).toContain('ok.off("pointerout")');
    expect(script).toContain('ok.listeners("pointerover").slice()');
  });

  it("⚠ 階段一結束就放掉，不能壓過階段邊界", () => {
    // 壓過邊界的 I_am_ok 屬於已經結束的階段，沒有意義；而且琥珀色會跟著
    // 跑到攻擊／防禦階段。2026-08-02 實測：壓滿 25 秒到失效保護才送出。
    expect(script).toContain('state.release("phase-ended")');
    expect(script).toContain("state.phaseTick = setInterval");
  });

  it("⚠ 染色代表「階段」不代表「狀態」", () => {
    // 移動階段整段都是琥珀色（按下去、取消回來都一樣），其他階段完全還原。
    // 早期版本把染色綁在「準備中」，取消後變回白色 —— 同一個階段裡顏色
    // 自己打架，玩家分不出那是階段標示還是狀態標示。
    //
    // engaged 看的是 holdThisPhase 而不是 alive：**降級中準備功能仍然在運作**
    // （單邊的反悔窗口還在），外觀就不該說它已經沒了。真正該還原的時機是
    // 下一個階段開始、holdThisPhase 重算成 false 的那一刻。
    // ⚠ inPvpMatch() 必須跟 shouldIntercept() 用同一個判準：打渦時染了色卻不會
    // 攔，那個顏色就是在說謊，而玩家會照著它去按 OK。
    expect(script).toContain(
      "var engaged = inPhase && state.armed && state.holdThisPhase && inPvpMatch();",
    );
    expect(script).toContain("if (engaged && !state.tinted)");
    expect(script).toContain("sc.ok.clearTint();");
    // setOkFrame 不可以再碰染色
    const body = script.slice(
      script.indexOf("setOkFrame: function"),
      script.indexOf("pinned: null"),
    );
    expect(body).not.toContain("setTint");
  });

  it("只在移動階段攔截", () => {
    // 攻擊／防禦階段沒有「先承諾被懲罰」的不對稱，壓住 OK 只會拖慢節奏。
    expect(script).toContain("shouldIntercept()");
    expect(script).toContain("MovePhaseA");
  });

  it("判斷不出階段時放行，不要亂攔", () => {
    // 放行是安全的；攔錯階段會拖慢玩家。movePhase() 有兩條 return null：
    // 一條是「清單裡的場景都不 active」，一條是 catch。
    //
    // ⚠ 範圍要**只圈住 movePhase()**。舊版是從 inInterceptPhase() 一路切到
    // nodeAlive()，那中間還夾著 battleRule / inPvpMatch / patchDisplay ——
    // 加一個函式就會讓這條紅掉，而它其實一點問題都沒有。
    const start = script.indexOf("function movePhase()");
    const body = script.slice(start, script.indexOf("var GAME_PHASE_SECONDS", start));
    expect(body.match(/return null/g)).toHaveLength(2);
  });

  it("⚠ 攔不攔在階段開始就定案，中途不會改", () => {
    // companion 結束之後頁面上的 patch 還活著的話，它不能變成一把沒有鑰匙的鎖：
    // 照攔不誤但沒有人能下 cancel／release，玩家每個移動階段被壓滿 25 秒而且
    // 取消不了（2026-08-03 實測）。
    //
    // 但反過來「心跳一過期就當場停攔並送出」也有傷害：玩家剛按下 OK、以為
    // 還能反悔，那次按壓卻在他不知情時定案了。
    //
    // 所以判準改成 holdThisPhase，而且**不對稱**：開啟隨時生效、關閉只在
    // 階段邊界。沒有鑰匙的鎖由 localDeadline 那條路解決。
    expect(script).toContain(
      "return state.holdThisPhase && state.armed && inInterceptPhase() && inPvpMatch();",
    );
    // 唯一會變成 false 的地方在階段邊界（setHold 是玩家自己下的令，另計）
    expect(script).toContain("state.holdThisPhase = false;");
    expect(script).toContain("if (state.hold && alive) state.holdThisPhase = true;");
    expect(script).toContain('state.release("local-deadline")');
  });

  it("⚠ 預設不染色 —— 官方原本的樣子", () => {
    // 玩家指定的預設值。染色是選項，不是強制。
    expect(configOf(script).readyTint).toBeNull();
    expect(
      configOf(buildOkPatchScript({ bindingName: "x", readyTint: READY_TINT_AMBER })).readyTint,
    ).toBe(READY_TINT_AMBER);
  });

  it("⚠ 壞掉的顏色當成不染色，不要變成全黑", () => {
    // 夾成 0x000000 的話 OK 鈕會全黑，看起來像遊戲壞了，而玩家完全不會
    // 聯想到是自己在設定裡填錯了一個顏色。
    for (const bad of [-1, 0x1000000, Number.NaN]) {
      expect(
        configOf(buildOkPatchScript({ bindingName: "x", readyTint: bad })).readyTint,
      ).toBeNull();
    }
  });

  it("攔下之後要把 OK 鈕變回可按", () => {
    // 遊戲的 pointerdown handler 剛剛 disableInteractive() 了。
    // 不救回來的話「再按一次取消」按不到。
    expect(script).toContain('state.setOkFrame("2", true);');
  });

  it("只攔 I_am_ok，其餘照原樣送出", () => {
    expect(script).toContain("if (String(name) === CFG.okEvent && shouldIntercept())");
    expect(script).toContain("return state.originalEmit.apply(this, arguments);");
  });

  it("⚠ 重複求值要先拆掉舊 patch，不能只換設定", () => {
    // 只換設定的話，改了程式碼完全不會生效 —— 症狀是「測試綠了但實際跑起來
    // 沒反應」。2026-08-02 在 pinFrame 上踩到（頁面跑的還是舊函式）。
    expect(script).toContain("prev.proto[CFG.sendMethod] = prev.originalEmit");
    expect(script).toContain("window[G] = null;");
  });

  it("⚠ release 自己要收拾外觀，不能指望 Node 下指令", () => {
    // 失效保護那條路完全沒有 Node；硬底線那條路 step() 只回 send-ok
    // 不回 set-ok-frame，所以 commandsFor 的 interactive:false 永遠輪不到。
    // 少了這個，琥珀色鎖頭會一路留到下個階段 —— 玩家以為還在準備中，
    // 其實早就送出去了（2026-08-02 實測踩到）。
    expect(releaseBody()).toContain("state.pinFrame(null)");
  });

  it("⚠ 送出之後 OK 鈕必須**不可按**，否則會攔到第二個 I_am_ok", () => {
    // 只拆 pin 是不夠的（2026-08-03 實測）。拆掉之後遊戲自己的 hover handler
    // 回來了，而按鈕還停在 frame 2 且仍然 setInteractive()：
    //
    //   滑鼠移開 → pointerout → frame 0 → 看起來像「準備被取消」，
    //                                     其實 I_am_ok 早就送出去了
    //   再按一次 → state.held 已是 null → 攔到第二個 I_am_ok，再壓一輪失效保護
    //
    // 正確的終態是 frame 2 + disableInteractive —— 那正好是遊戲原本按完 OK
    // 的樣子，所以下個階段遊戲會自己還原。
    expect(releaseBody()).toContain('state.setOkFrame("2", false)');
  });

  it("⚠ 階段已經結束就不要碰按鈕的可按狀態", () => {
    // 那時 OK 鈕已經屬於下一個階段，遊戲可能早就把它設回可按了。
    // stomp 過去會把玩家的 OK 鈕鎖死在攻擊／防禦階段 —— 比原本的 bug 更糟。
    expect(releaseBody()).toContain("if (inInterceptPhase()) state.setOkFrame");
  });

  it("⚠ 換 socket 要重掛 onAny，不能只 patch 原型", () => {
    // 原型上的 patch 跨場活著，實例上的 onAny 換房就沒了（SOCKET_LIFETIME_NOTE）。
    // 只 patch 原型的結果是：攔截照常，但出牌／轉牌不再回報 → 取消準備永遠
    // 不會觸發，又是一把單向的鎖。
    expect(script).toContain("if (state.socket !== socket)");
    expect(script).toContain("socket[CFG.listenAllMethod](onAnyHandler)");
    expect(script).toContain("state.socket[CFG.unlistenAllMethod](onAnyHandler)");
    expect(script).toContain('report({ type: "ok-patch-rearmed"');
  });

  it("⚠ 重複 arm 不能把 originalEmit 換成自己", () => {
    // arm() 每 200ms 被叫一次。少了這個判斷，第二次就會把 patchedEmit 存成
    // originalEmit —— 下一次 release 無限遞迴，整個分頁當掉。
    expect(script).toContain("if (proto[CFG.sendMethod] !== patchedEmit)");
  });

  it("沒 socket 也要裝得起來，之後自己補掛", () => {
    // 玩家的順序是「先開 companion 再開遊戲」。早期版本在這裡直接回
    // no-socket 讓呼叫端放棄，等於逼玩家先進對戰再啟動插件。
    expect(script).toContain('return armed ? "ok" : "waiting";');
    // phaseTick 必須在 arm() 之前就跑起來，否則沒 socket 時沒有人會去補掛
    expect(script.indexOf("state.phaseTick = setInterval")).toBeLessThan(
      script.indexOf("var armed = arm();"),
    );
  });

  it("拆之前要先把壓著的呼叫送出去", () => {
    // 半路換 patch 而把它丟掉的話，玩家會逾時棄權。
    expect(script).toContain('prev.release("reinstall")');
  });

  it("常數從 constants 帶進來，不寫死", () => {
    expect(script).toContain(WS_CLIENT.sendMethod);
    expect(script).toContain(WS_CLIENT.listenAllMethod);
    expect(script).toContain(OK_BUTTON.scene);
    expect(script).toContain(OK_BUTTON.textureKey);
    expect(script).toContain(OK_PATCH_GLOBAL);
  });

  it("座位是讀 PLAYER，不是自己推的", () => {
    // 原始碼：this.socket.on(`okVisible${this.PLAYER}`, …)
    expect(script).toContain("sc.PLAYER");
  });

  it("倒數讀 (380,318) 的 BitmapText，並用 parseFloat", () => {
    // 低於 10 秒會變成一位小數（9.2 / 8.2），parseInt 會把精度丟掉。
    expect(script).toContain("parseFloat");
    expect(script).toContain("380");
    expect(script).toContain("318");
  });
});

// ---------------------------------------------------------------------------
// 真的把腳本跑起來
// ---------------------------------------------------------------------------

/**
 * 上面那些字串比對釘得住「這行程式有沒有寫」，釘不住「它做的事對不對」。
 *
 * 這個檔案裡最貴的兩個 bug 都是後者：`release()` 拆了 pin 卻沒收外觀、
 * 以及 patch 在沒人管的情況下照樣攔截。兩個都會通過字串比對。
 *
 * 所以這一段用 `node:vm` 架一個夠像的假頁面，把產生出來的腳本真的跑起來。
 * 假的部分只有 Phaser 與 WSClient 的**行為**（frame、hover、原型共用、
 * onAny 掛在實例上），那些都是實測確認過的。
 */

/** 遊戲的 OK 鈕。frame 與可按狀態是分開的兩件事 —— 那正是坑 #1。 */
class FakeOkButton {
  frame = 0;
  interactive = true;
  tint: number | null = null;
  #listeners: Record<string, ((...a: unknown[]) => void)[]> = {};

  setTexture(_key: string, frame: number): this {
    this.frame = frame;
    return this;
  }
  setInteractive(): this {
    this.interactive = true;
    return this;
  }
  disableInteractive(): this {
    this.interactive = false;
    return this;
  }
  setTint(t: number): this {
    this.tint = t;
    return this;
  }
  clearTint(): this {
    this.tint = null;
    return this;
  }
  on(name: string, fn: (...a: unknown[]) => void): this {
    (this.#listeners[name] ??= []).push(fn);
    return this;
  }
  off(name: string): this {
    this.#listeners[name] = [];
    return this;
  }
  listeners(name: string): ((...a: unknown[]) => void)[] {
    return this.#listeners[name] ?? [];
  }
  /**
   * Phaser 的 GameObject 就是 EventEmitter —— `emit("pointerdown")` 會直接叫
   * handler，**不管物件可不可按**。WP-15 的「替玩家按 OK」靠的就是這條。
   */
  emit(name: string, ...args: unknown[]): boolean {
    const fns = [...this.listeners(name)];
    for (const fn of fns) fn(...args);
    return fns.length > 0;
  }

  /** 遊戲自己那組 hover handler（實測從 MainA 的原始碼挖出來的）。 */
  installGameHover(): void {
    this.on("pointerover", () => this.setTexture("ok", 1));
    this.on("pointerout", () => this.setTexture("ok", 0));
  }

  /** 滑鼠移開。⚠ 不可按的物件在 Phaser 裡根本不會收到指標事件。 */
  hoverOut(): void {
    if (!this.interactive) return;
    for (const fn of [...this.listeners("pointerout")]) fn();
  }
}

interface FakeSocket {
  anyHandlers: ((...a: unknown[]) => void)[];
  /**
   * 遊戲的 WSClient 把底下那顆 WebSocket 的 readyState 透出來
   * （0 連線中 / 1 開著 / 2 關閉中 / 3 已關閉）。
   *
   * ⚠ **沒有 connected 這個欄位** —— 2026-08-20 實測，那是 socket.io 的形狀，
   * 不是這個客戶端的。戰鬥結束後兩個客戶端讀到的都是 3。
   */
  readyState: number;
  fire(...args: unknown[]): void;
  emit(...args: unknown[]): void;
  onAny(fn: (...a: unknown[]) => void): void;
  offAny(fn: (...a: unknown[]) => void): void;
}

/**
 * 一個假的 WSClient 世界。
 *
 * ⚠ 重點是**原型共用、實例各自** —— 那是 SOCKET_LIFETIME_NOTE 描述的形狀，
 * 也是「換房之後取消準備失效」的成因。
 */
function makeSocketWorld(): { sent: unknown[][]; makeSocket: () => FakeSocket } {
  const sent: unknown[][] = [];
  const proto = {
    emit(...args: unknown[]): void {
      sent.push(args);
    },
    onAny(this: FakeSocket, fn: (...a: unknown[]) => void): void {
      this.anyHandlers.push(fn);
    },
    offAny(this: FakeSocket, fn: (...a: unknown[]) => void): void {
      this.anyHandlers = this.anyHandlers.filter((h) => h !== fn);
    },
  };
  const makeSocket = (): FakeSocket => {
    const s = Object.create(proto) as FakeSocket;
    s.anyHandlers = [];
    s.readyState = 1; // OPEN —— 對戰中的樣子

    s.fire = (...args: unknown[]): void => {
      for (const h of [...s.anyHandlers]) h(...args);
    };
    return s;
  };
  return { sent, makeSocket };
}

interface Page {
  status: unknown;
  ok: FakeOkButton;
  reports: OkPatchReport[];
  sent: unknown[][];
  socket: FakeSocket | null;
  arbiter: {
    tick(): {
      remaining: number | null;
      armed: boolean;
      seat: string | null;
      inPhase: boolean;
      pvp: boolean;
      rule: string | null;
      phaseId: number;
      hazard: boolean;
      hold: boolean;
      sent: boolean;
      room: string | null;
    };
    release(by: string): string;
    forceEnd(why?: string): string;
    cancel(): string;
    uninstall(why?: string): string;
    setOkFrame(frame: string, interactive?: boolean): boolean;
    setHold(on: boolean): boolean;
    setDisplayCap(n: number | null): number | null;
    held: unknown;
    armed: boolean;
  };
  /** 換一顆 socket（重新開房）。 */
  swapSocket(): FakeSocket;
  /** 連線建好（本來還在大廳）。 */
  attachSocket(): FakeSocket;
  /** 把倒數推到某個秒數。`null` = 讀不到（模擬場景還沒建好）。 */
  setTimeLimit(seconds: number | null): void;
  /** 進入／離開移動階段。用來跨階段邊界。 */
  setInPhase(active: boolean): void;
  setMovePhase(active: boolean): void;
  /** 讓 MovePhaseA 走一幀，並可順便設定剩餘秒數。 */
  frame(timelimit?: number): { text: string; scaleX: number; fill: number };
  /** 手牌換成這些 event_info 索引。91 = 聖水。 */
  setHand(frames: readonly number[]): void;
  /** 換戰鬥模式。`null` = 讀不到（還沒進戰鬥，或改版換了欄位）。 */
  setRule(rule: string | null): void;
  /** 設定畫面上顯示的狀態圖示（種類 + 剩餘回合）。 */
  setStatuses(entries: readonly { key: string; turns: number }[]): void;
  /**
   * 戰鬥結束。**照 MainA.on_result 的實際順序**（2026-08-20 從跑著的客戶端
   * 讀出來的）：先關連線，好幾秒之後場景才收掉。
   *
   * ⚠ 兩件事一定要分開做得到 —— 中間那段時間（結算動畫、語音）是真實存在的，
   * 而插件在那段時間裡就已經該停手了。
   */
  endBattle(step: "socket" | "scene"): void;
  /** MainA 起來了／收掉了。下一場開始就是 `true` + `swapSocket()`。 */
  setMainActive(active: boolean): void;
  /**
   * MainA 被暫停（Phaser 的 PAUSED=6：`active` 變 false，但場景還在）。
   *
   * ⚠ **暫停不是結束。** 這是 `battleLive()` 看 `status` 而不看 `active`
   * 的唯一理由，所以假頁面要做得出這個狀態。
   */
  pauseMain(): void;
}

const BINDING = "__test_binding";

/**
 * 起一個假頁面。
 *
 * ⚠ `readyTint` 預設給琥珀色，**跟正式預設值（不染色）相反**。理由是這一批
 * 測試多半在驗染色的行為，而正式預設值本身另有一條測試釘住
 * （「⚠ 預設不染色」）。要驗「不染色」的行為就明確傳 `readyTint: null`。
 */
function bootPage(
  options: { withSocket?: boolean; readyTint?: number | null; rule?: string | null } = {},
): Page {
  const pageScript = buildOkPatchScript({
    bindingName: "__test_binding",
    readyTint: options.readyTint === undefined ? READY_TINT_AMBER : options.readyTint,
  });
  const { sent, makeSocket } = makeSocketWorld();
  const ok = new FakeOkButton();
  ok.installGameHover();
  const reports: OkPatchReport[] = [];

  const timer = { type: "BitmapText", x: 380, y: 318, visible: true, text: "30" };
  /** 手牌一格：帶 event_asset 材質的 sprite，frame 名就是 event_info 的索引。 */
  const handCard = (frame: number): unknown => [
    { texture: { key: "event_asset" }, frame: { name: String(frame) }, visible: true },
  ];
  const mainA: Record<string, unknown> = {
    ok,
    PLAYER: "A",
    room: "room-1",
    id: "player-1",
    socket: options.withSocket === false ? undefined : makeSocket(),
    /**
     * ⚠ **status 要跟 active 一起給。** Phaser 的 5 = RUNNING、8 = SHUTDOWN
     * （2026-08-20 對著跑著的客戶端實測：打完之後 MainA 是 8）。判斷戰鬥有沒有
     * 結束看的是 status —— 只給 active 的假頁面會讓那條路完全測不到。
     */
    sys: { settings: { active: true, status: 5 } },
    // 0=劍1卡、91=聖水（實測索引，見 constants.ts 的 EVENT_INFO_JSON_KEY）
    arr1: [handCard(0), handCard(0)],
    /**
     * ⚠ **預設是對戰**，因為這個檔案裡幾乎每一條測試都在驗「有在管的時候」
     * 的行為。要驗 NPC（任務／渦）就明確 `setRule("quest")`。
     *
     * 實測形狀：`MainA.config.rule`，值是 quest / raid / event / duel / ranked
     * （2026-08-09，見 constants.ts 的 PVP_RULES）。
     */
    config: { rule: options.rule === undefined ? "duel" : options.rule },
    /**
     * 畫面上那排狀態圖示。**實測形狀**（2026-08-10）：一個容器裡放
     * 一張 `state_tmp` 的圖（frame 名就是狀態鍵）＋一個 BitmapText（剩餘回合）。
     */
    /**
     * ⚠ **一定要放在 children.list，不是 list。**
     * Phaser 的 Scene 是 children.list，容器才是 list。假頁面用 list 的話，
     * 只看 list 的實作會在測試裡全綠、在真的頁面上一個狀態都讀不到
     * —— 2026-08-10 真的踩到了。
     */
    children: { list: [] as unknown[] },
  };
  /** 遊戲自己的 pointerdown handler，逐字抄實測挖到的那一行。 */
  ok.on("pointerdown", () => {
    ok.setTexture("ok", 2);
    ok.disableInteractive();
    (mainA["socket"] as FakeSocket | undefined)?.emit("I_am_ok", mainA["room"], mainA["id"]);
  });
  /**
   * 假的 MovePhaseA。
   *
   * ⚠ `update()` 掛在**原型**上，因為 patchDisplay 包的是原型（實測遊戲的
   * 場景類別就是這個形狀）。掛在實例上的話 patch 會找不到東西可包，而測試
   * 會綠得毫無意義。
   */
  const movePhaseProto = {
    update(this: Record<string, unknown>): void {
      // 遊戲原本的畫法：三樣東西都是 timelimit 的純函式，分母寫死 30。
      const t = this["timelimit"] as number;
      (this["text"] as { setText(v: string): void }).setText(
        t > 10.1 || (t <= 10 && t >= 1) ? t.toPrecision(2) : t.toPrecision(1),
      );
      const ci = Math.max(0, Math.trunc((t / 30) * 240));
      this["colorIdx"] = ci;
      (this["guage"] as { setFillStyle(c: number): void }).setFillStyle(
        (this["hsv"] as { color: number }[])[ci]!.color,
      );
      (this["guage"] as { scaleX: number }).scaleX = (t / 30) * 0.934 + 0.066;
    },
  };
  const movePhaseA: Record<string, unknown> = Object.create(movePhaseProto) as Record<
    string,
    unknown
  >;
  // ⚠⚠ **Phaser 在 Systems.init 就把 scene.update 抄了一份**，之後每一幀跑的是
  // 那份抄本，不是原型上那個。假的頁面一定要照抄這個行為 —— 少了它，只換原型
  // 的實作會在測試裡完全正常，然後在真的遊戲裡毫無反應（2026-08-06 實測踩到，
  // 而且症狀是「原型檢查起來明明是新版」）。
  movePhaseA["sys"] = {
    settings: { active: true },
    sceneUpdate: movePhaseProto.update,
  };
  movePhaseA["children"] = { list: [timer] };
  movePhaseA["timelimit"] = 30;
  movePhaseA["text"] = {
    value: "30",
    setText(v: string): void {
      (movePhaseA["text"] as { value: string }).value = v;
    },
  };
  movePhaseA["guage"] = {
    scaleX: 1,
    fill: 0,
    setFillStyle(c: number): void {
      (movePhaseA["guage"] as { fill: number }).fill = c;
    },
  };
  // 240 = 藍、0 = 紅，跟遊戲的 HSVColorWheel 同一個方向。
  movePhaseA["hsv"] = Array.from({ length: 241 }, (_v, i) => ({ color: i }));
  movePhaseA["colorIdx"] = 240;

  const scenes: Record<string, unknown> = { MainA: mainA, MovePhaseA: movePhaseA };

  const sandbox: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (t: unknown) => clearInterval(t as ReturnType<typeof setInterval>),
    // ⚠ vm context 有**自己的** Date，假時鐘只換掉主 realm 的那個。
    // 不把外面這顆傳進去的話，腳本裡的 Date.now() 讀的是真實時間 ——
    // 心跳永遠不會過期，而測試會綠得毫無意義。
    Date,
  };
  const eventInfo = {
    frames: Array.from({ length: 110 }, (_v, i) => ({
      holy: i === 91 || i === 94,
      holy_enemy: i === 95,
    })),
  };
  sandbox["window"] = {
    game: {
      scene: { keys: scenes },
      cache: { json: { get: (k: string) => (k === "event_info" ? eventInfo : null) } },
    },
    [BINDING]: (json: string) => reports.push(JSON.parse(json) as OkPatchReport),
  };

  const status: unknown = new Script(pageScript).runInNewContext(sandbox);
  const win = sandbox["window"] as Record<string, unknown>;

  return {
    status,
    ok,
    reports,
    sent,
    get socket(): FakeSocket | null {
      return (mainA["socket"] as FakeSocket | undefined) ?? null;
    },
    arbiter: win[OK_PATCH_GLOBAL] as Page["arbiter"],
    setTimeLimit(seconds: number | null): void {
      if (seconds !== null) {
        movePhaseA["timelimit"] = seconds;
        return;
      }
      // ⚠ 「讀不到」要把**兩個來源**都拿掉。remaining() 讀不到 timelimit 時會
      // 退回去掃畫面上那個 BitmapText，只刪一個的話它照樣讀得到 30。
      delete movePhaseA["timelimit"];
      timer.visible = false;
    },
    setInPhase(active: boolean): void {
      (movePhaseA["sys"] as { settings: { active: boolean } }).settings.active = active;
    },
    swapSocket(): FakeSocket {
      const next = makeSocket();
      mainA["socket"] = next;
      return next;
    },
    attachSocket(): FakeSocket {
      const next = makeSocket();
      mainA["socket"] = next;
      return next;
    },
    setMovePhase(active: boolean): void {
      (movePhaseA["sys"] as { settings: { active: boolean } }).settings.active = active;
    },
    frame(timelimit?: number): { text: string; scaleX: number; fill: number } {
      if (timelimit !== undefined) movePhaseA["timelimit"] = timelimit;
      // ⚠ 走 sys.sceneUpdate，就跟 Phaser 的 Systems.step 一樣。
      // 直接叫 movePhaseA.update() 會讓「只換原型」的實作假裝成功。
      (movePhaseA["sys"] as { sceneUpdate: () => void }).sceneUpdate.call(movePhaseA);
      return {
        text: (movePhaseA["text"] as { value: string }).value,
        scaleX: (movePhaseA["guage"] as { scaleX: number }).scaleX,
        fill: (movePhaseA["guage"] as { fill: number }).fill,
      };
    },
    setHand(frames: readonly number[]): void {
      mainA["arr1"] = frames.map((f) => handCard(f));
    },
    setStatuses(entries: readonly { key: string; turns: number }[]): void {
      (mainA["children"] as { list: unknown[] }).list = entries.map((e) => ({
        visible: true,
        list: [
          { visible: true, texture: { key: "state_tmp" }, frame: { name: e.key } },
          { visible: true, type: "BitmapText", text: String(e.turns) },
        ],
      }));
    },
    setRule(rule: string | null): void {
      // ⚠ 整顆 config 拿掉，不是把 rule 設成 null —— 「還沒進戰鬥」時
      // MainA.config 本身就不存在，讀 config.rule 會是存取 undefined 的屬性。
      if (rule === null) delete mainA["config"];
      else mainA["config"] = { rule };
    },
    endBattle(step: "socket" | "scene"): void {
      // ⚠ **room / config / socket / ok 全部留著不動** —— Phaser 不丟場景物件，
      // 而那正是這個 bug 的成因。假頁面只要少留一個欄位，測試就會綠得毫無意義。
      if (step === "socket") {
        const so = mainA["socket"] as FakeSocket | undefined;
        if (so) so.readyState = 3; // CLOSED
        return;
      }
      // MainA.on_result 最後做的事：scene.stop() 自己（Phaser 的 SHUTDOWN=8）。
      const s = (mainA["sys"] as { settings: { active: boolean; status: number } }).settings;
      s.active = false;
      s.status = 8;
    },
    setMainActive(active: boolean): void {
      const s = (mainA["sys"] as { settings: { active: boolean; status: number } }).settings;
      s.active = active;
      s.status = active ? 5 : 8;
    },
    pauseMain(): void {
      const s = (mainA["sys"] as { settings: { active: boolean; status: number } }).settings;
      s.active = false;
      s.status = 6; // PAUSED
    },
  };
}

/**
 * 玩家按下 OK。
 *
 * ⚠ 走的是**遊戲的**路徑：不可按的鈕收不到 pointerdown，所以什麼都不會發生。
 * 直接呼叫 `socket.emit` 會繞過這一層，測到的東西就不是玩家會遇到的。
 */
function pressOk(page: Page): void {
  if (!page.ok.interactive) return;
  // 遊戲的 pointerdown handler 先做這兩件事，再 emit。
  page.ok.setTexture("ok", 2);
  page.ok.disableInteractive();
  page.socket?.emit("I_am_ok", "room-1", 7);
}

/** 讓 phaseTick 跑 n 輪（每輪 200ms）。 */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(200);
}

describe("跑起來：心跳與攔截", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⚠ 沒有心跳就完全不攔 —— 退回遊戲原本的行為", async () => {
    // 這是「companion 已經結束、頁面上的 patch 還活著」那個情境。
    // 2026-08-03 之前它會照攔不誤，然後把玩家鎖滿 25 秒且取消不了。
    const page = bootPage();
    await ticks(2);
    pressOk(page);

    expect(page.sent).toHaveLength(1); // 真的送出去了
    expect(page.arbiter.held).toBeNull();
    expect(page.ok.tint).toBeNull(); // 也不該宣稱自己在管
  });

  it("有心跳就攔，而且按鈕保持可按（才取消得了）", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);

    expect(page.sent).toHaveLength(0);
    expect(page.arbiter.held).not.toBeNull();
    expect(page.ok.frame).toBe(2);
    expect(page.ok.interactive).toBe(true);
    expect(page.ok.tint).not.toBeNull();
  });

  it("⚠ 壓著的時候滑鼠移開，不可以變回未準備的樣子", async () => {
    // pin 就是為了這個：遊戲的 pointerout 會 setTexture("ok", 0)。
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    page.ok.hoverOut();

    expect(page.ok.frame).toBe(2);
  });

  it("⚠ 送出之後滑鼠移開，也不可以看起來像被取消了", async () => {
    // 這就是玩家回報的那個 bug：release() 只拆 pin、沒有收外觀，於是
    // 遊戲的 hover handler 回來把 frame 改成 0 —— 看起來像取消，
    // 其實 I_am_ok 早就送出去了，而且按鈕還能按（會攔到第二個）。
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    page.arbiter.release("arbiter");

    expect(page.sent).toHaveLength(1);
    expect(page.ok.frame).toBe(2);
    expect(page.ok.interactive).toBe(false);

    page.ok.hoverOut();
    expect(page.ok.frame).toBe(2);

    // 已經送出去了就按不動 —— 否則會攔到第二個 I_am_ok 再壓一輪
    pressOk(page);
    expect(page.arbiter.held).toBeNull();
    expect(page.sent).toHaveLength(1);
  });

  it("⚠ Node 斷了不要當場把壓著的送出 —— 玩家以為還能反悔", async () => {
    // 這是這一整組的核心。舊行為是心跳一過期就 release("node-gone")：
    // 玩家剛按下 OK、看到按鈕變色、以為「再按一次就取消」，而那次按壓
    // 在他不知情的狀況下已經定案了。畫面上什麼都沒說。
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    expect(page.arbiter.held).not.toBeNull();

    // 心跳停 3 秒以上（staleMs = 3000）。
    await ticks(20);

    // 還壓著，還沒送出 —— 反悔窗口沒有在玩家腳下消失。
    expect(page.sent).toHaveLength(0);
    expect(page.arbiter.held).not.toBeNull();
    const degraded = page.reports.filter((r) => r.type === "ok-degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ holding: true });
  });

  it("降級之後「再按一次取消」仍然有效 —— 那本來就不需要 Node", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    await ticks(20); // 心跳過期，進入降級

    // 頁面自己就能取消，不必等任何人。
    expect(page.arbiter.cancel()).toBe("cancelled");
    expect(page.arbiter.held).toBeNull();
    expect(page.sent).toHaveLength(0);
  });

  it("⚠ 降級中由頁面自己顧硬底線 —— 剩 3 秒一定送出，不會害玩家棄權", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    await ticks(20); // 降級中，還壓著
    expect(page.sent).toHaveLength(0);

    // 倒數走到剩 3 秒。failsafe 是 25 秒、從按下去算起，救不到這裡。
    page.setTimeLimit(3);
    await ticks(1);

    expect(page.sent).toHaveLength(1);
    const released = page.reports.filter((r) => r.type === "ok-released");
    expect(released.at(-1)).toMatchObject({ by: "local-deadline" });
  });

  it("⚠ 讀不到剩餘秒數就提早送出 —— 沒有安全網時寧可早，不可以晚", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    page.setTimeLimit(null); // 讀不到 timelimit
    await ticks(20);

    expect(page.sent).toHaveLength(1);
    expect(page.reports.filter((r) => r.type === "ok-released").at(-1)).toMatchObject({
      by: "local-deadline",
    });
  });

  it("⚠ 到下一個階段才真的把功能關掉 —— 開關只在階段邊界改變", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    await ticks(20); // 心跳過期，這個階段仍然 engaged
    expect(page.ok.tint).not.toBeNull();

    // 離開移動階段再進來一次 —— 這時才重算 holdThisPhase。
    page.setInPhase(false);
    await ticks(1);
    page.setInPhase(true);
    await ticks(1);

    // Node 還是死的 → 這個階段完全不攔，也不宣稱自己在管。
    expect(page.ok.tint).toBeNull();
    pressOk(page);
    expect(page.arbiter.held).toBeNull();
    expect(page.sent).toHaveLength(1); // 直接送出去，遊戲原本的行為
  });

  it("心跳在同一個階段內回來的話，什麼都沒發生過", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    await ticks(20); // 降級
    page.arbiter.tick(); // Node 回來了

    // 壓著的還在，Node 可以照常下指令。
    expect(page.arbiter.held).not.toBeNull();
    expect(page.arbiter.release("arbiter")).toBe("released");
    expect(page.sent).toHaveLength(1);
  });
});

describe("跑起來：只對真人對戰生效（玩家 2026-08-09 回報）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 症狀：打渦、打任務時準備與約定秒數照樣生效。
   *
   * 成因不是邏輯寫錯 —— 是判準少了一個維度。任務與渦的移動階段跟對戰**長得
   * 一模一樣**（實測兩者都讓 MovePhaseA active），所以「在不在移動階段」這個
   * 問題在兩種情況下都回答「在」。
   */
  for (const rule of ["quest", "raid", "event"]) {
    it(`⚠ ${rule}：按 OK 直接送出，一點都不攔`, async () => {
      const page = bootPage({ rule });
      page.arbiter.tick();
      await ticks(1);
      pressOk(page);

      expect(page.sent).toHaveLength(1);
      expect(page.arbiter.held).toBeNull();
    });

    it(`⚠ ${rule}：絕對不可以替玩家按 OK`, async () => {
      // 這是最有感的那一半 —— 玩家在打王，而插件替他結束了移動階段。
      const page = bootPage({ rule });
      page.arbiter.tick();
      await ticks(1);

      expect(page.arbiter.forceEnd("arbiter")).toBe("not-pvp");
      expect(page.sent).toHaveLength(0);
    });
  }

  it("ranked（排名戰）跟 duel 一樣是真人，要照常生效", async () => {
    // 遊戲自己就是用 ("duel"===rule || "ranked"===rule) 圍住投降與貼圖的。
    const page = bootPage({ rule: "ranked" });
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);

    expect(page.sent).toHaveLength(0);
    expect(page.arbiter.held).not.toBeNull();
  });

  it("⚠ 讀不到 rule 就當成不是對戰 —— 不確定時停手", async () => {
    // 方向是刻意的：不介入只是功能沒開，介入錯了是替玩家做了他沒要求的決定。
    // 遊戲改版把 config.rule 換掉時，這條決定我們是安靜失效還是亂按 OK。
    const page = bootPage({ rule: null });
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);

    expect(page.sent).toHaveLength(1);
    expect(page.arbiter.tick().pvp).toBe(false);
    expect(page.arbiter.tick().rule).toBeNull();
  });

  it("⚠ 認不得的新模式也當成不是對戰", async () => {
    // 白名單的失敗方向：改版多一種 PvE 模式 → 功能沒生效（安全）。
    // 黑名單會反過來 → 在打王時替玩家按 OK（有害）。見 constants.ts 的 NPC_RULES。
    const page = bootPage({ rule: "boss_rush" });
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);

    expect(page.sent).toHaveLength(1);
    expect(page.arbiter.tick().pvp).toBe(false);
  });

  it("⚠ 打 NPC 時不可以染色 —— 那個顏色代表「插件在管這個階段」", async () => {
    const page = bootPage({ rule: "raid" });
    page.arbiter.tick();
    await ticks(2);
    expect(page.ok.tint).toBeNull();

    // 對照組：同一個頁面換成對戰就該染上去。
    page.setRule("duel");
    page.setMovePhase(false);
    await ticks(1);
    page.setMovePhase(true);
    page.arbiter.tick();
    await ticks(1);
    expect(page.ok.tint).not.toBeNull();
  });

  it("⚠ 打 NPC 時不可以改寫讀秒 —— 就算 cap 還留著", async () => {
    // Node 那邊也會把 cap 推成 null，但那是**另一個程序**。它沒跑到、跑慢了、
    // 或整個掛掉時，畫面上仍然不可以出現一個假的倒數。
    const page = bootPage({ rule: "quest" });
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.setDisplayCap(15);

    expect(page.frame(30)).toEqual({ text: "30", scaleX: 1, fill: 240 });
  });

  it("tick 要把模式帶回 Node", async () => {
    const page = bootPage({ rule: "raid" });
    page.arbiter.tick();
    await ticks(1);
    expect(page.arbiter.tick()).toMatchObject({ pvp: false, rule: "raid" });

    page.setRule("duel");
    expect(page.arbiter.tick()).toMatchObject({ pvp: true, rule: "duel" });
  });

  it("打完對戰接著打任務，同一個 patch 要跟著改判", async () => {
    // 換場不會重裝 patch（socket 換一顆而已），所以模式判斷必須是**每次現讀**，
    // 不能在安裝時算一次就快取起來 —— 那正是座位那個 bug 的形狀。
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    expect(page.arbiter.held).not.toBeNull();
    page.arbiter.release("arbiter");

    page.setRule("quest");
    page.swapSocket();
    page.setMovePhase(false);
    await ticks(1);
    page.setMovePhase(true);
    // 新階段開始時**遊戲自己**會把 OK 鈕還原成可按 —— 上一個階段送出後它停在
    // frame 2 + disableInteractive。假頁面沒有那段，手動補上，否則下面的
    // pressOk 會因為「按鈕按不動」而什麼都不做，測試就變成假綠。
    page.ok.setTexture("ok", 0);
    page.ok.setInteractive();
    page.arbiter.tick();
    await ticks(1);

    const before = page.sent.length;
    pressOk(page);
    expect(page.sent).toHaveLength(before + 1); // 直接送出，沒攔
    expect(page.arbiter.held).toBeNull();
  });
});

/**
 * 戰鬥結束（玩家 2026-08-20 回報）
 * ================================
 * 症狀：打完了，托盤還寫著「對戰中、已握手」，而且會影響到下一場 ——
 * 下一場的對手沒插件，準備卻照樣攔。
 *
 * 成因不是仲裁邏輯，是**觀測**：Phaser 的場景物件建一次就留著，結算畫面上
 * MainA 的 room / config.rule / socket / ok 全部原封不動還在，所以
 * 「還在不在對戰」如果只讀那些欄位，答案永遠是「在」。
 *
 * ⚠ 這一組測試的假頁面**刻意把那些欄位全部留著**。少留一個，測試就會因為
 * 「讀不到所以回 null」而綠，而真的頁面上一個都不會少。
 */
describe("戰鬥結束就不要再握手", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⚠ 連線關掉的那一刻就算結束 —— 場景還要好幾秒才收掉", async () => {
    // MainA.on_result 的順序（實測）：socket.disconnect() 在最前面，接著等
    // 結束語音播完（可能好幾秒）才 scene.stop()。中間那段時間也不該再握手。
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);
    expect(page.arbiter.tick()).toMatchObject({ pvp: true, rule: "duel", room: "room-1" });

    page.endBattle("socket");

    expect(page.arbiter.tick()).toMatchObject({ pvp: false, rule: null, room: null });
  });

  it("⚠ 場景收掉了也算 —— 改版拿掉 disconnect 時還有這一道", async () => {
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);

    page.endBattle("scene");

    expect(page.arbiter.tick()).toMatchObject({ pvp: false, rule: null, room: null });
  });

  it("⚠⚠ 房號一定要跟著變 null —— 側通道就是靠它退房的", async () => {
    // 這是玩家回報的那半：房號還在 → 兩個插件留在上一場的房裡繼續配對成功，
    // 於是下一場（對手沒插件）照樣有 both-ready 與約定秒數。
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);
    expect(page.arbiter.tick().room).toBe("room-1");

    page.endBattle("socket");

    expect(page.arbiter.tick().room).toBeNull();
    // ⚠ 而且欄位本身還在場景上 —— 我們是**選擇不報**，不是讀不到。
    expect(page.arbiter.tick().pvp).toBe(false);
  });

  it("⚠ 結算畫面上不要再說「對戰中」", async () => {
    // 托盤的狀態列直接拿 armed 當「在不在對戰」用。攔截其實還掛在那顆
    // （已經關掉的）socket 上，所以只問「掛上了沒」會一直是 true。
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);
    expect(page.arbiter.tick().armed).toBe(true);

    page.endBattle("socket");

    expect(page.arbiter.tick().armed).toBe(false);
  });

  it("⚠ 暫停不算結束 —— 雙開時永遠有一邊沒有焦點", async () => {
    // 這是 battleLive() 看 status（>= 8 才算收掉）而不看 active 的唯一理由。
    // active 在 PAUSED / SLEEPING 也是 false，把某條暫停路徑誤判成「打完了」
    // 的代價是那一邊整場都不生效 —— 而雙開正是這個插件最常見的用法。
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);

    page.pauseMain();

    expect(page.arbiter.tick()).toMatchObject({ pvp: true, rule: "duel", room: "room-1" });
  });

  it("⚠ 結算畫面上絕對不可以替玩家按 OK", async () => {
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);
    page.endBattle("socket");

    const before = page.sent.length;
    expect(page.arbiter.forceEnd("arbiter")).toBe("not-pvp");
    expect(page.sent).toHaveLength(before);
  });

  it("下一場開始就整組回來 —— 停手是暫時的，不是永久的", async () => {
    // ⚠ 這條是另一半的保險。判斷改成「現讀」之後最危險的失敗是**回不來**：
    // 症狀會是「打完第一場之後插件就再也不管了」，而且完全沒有錯誤訊息。
    const page = bootPage({ rule: "duel" });
    page.arbiter.tick();
    await ticks(1);
    page.endBattle("socket");
    page.endBattle("scene");
    expect(page.arbiter.tick().pvp).toBe(false);

    // 新的一場：場景重新起來、換一顆新的 socket。
    page.setMainActive(true);
    page.swapSocket();
    page.arbiter.tick();
    await ticks(1);

    expect(page.arbiter.tick()).toMatchObject({ pvp: true, rule: "duel", room: "room-1" });
    expect(page.arbiter.tick().armed).toBe(true);
  });
});

describe("跑起來：跨場與生命週期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⚠ 重新開房換了 socket，出牌事件要跟著換過去", async () => {
    // 只 patch 原型的版本在這裡會壞：攔截照常，但操作事件不再回報，
    // 於是取消準備永遠不會觸發 —— 一把單向的鎖。
    const page = bootPage();
    const old = page.socket!;
    await ticks(1);

    const fresh = page.swapSocket();
    await ticks(1);

    expect(page.reports.some((r) => r.type === "ok-patch-rearmed")).toBe(true);

    fresh.fire("cardclickedB", 3, true);
    expect(page.reports.filter((r) => r.type === "ok-patch-event")).toHaveLength(1);

    // 舊的那顆不該再回報 —— 不拆的話同一則事件會送兩次
    old.fire("cardclickedB", 3, true);
    expect(page.reports.filter((r) => r.type === "ok-patch-event")).toHaveLength(1);
  });

  it("還沒進遊戲也裝得起來，連線建好之後自己補掛", async () => {
    const page = bootPage({ withSocket: false });
    expect(page.status).toBe("waiting");
    expect(page.arbiter.armed).toBe(false);

    page.attachSocket();
    await ticks(1);

    expect(page.arbiter.armed).toBe(true);
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    expect(page.arbiter.held).not.toBeNull();
  });

  it("⚠ uninstall 要還原 emit、拆掉 onAny，並先把壓著的送出去", async () => {
    const page = bootPage();
    const socket = page.socket!;
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    expect(page.sent).toHaveLength(0);

    expect(page.arbiter.uninstall("uninstall")).toBe("uninstalled");

    expect(page.sent).toHaveLength(1); // 壓著的沒有被丟掉
    expect(page.ok.tint).toBeNull();

    // 之後的 emit 完全走原路
    page.arbiter.tick();
    socket.emit("I_am_ok", "room-1", 7);
    expect(page.sent).toHaveLength(2);

    // onAny 也拆乾淨了
    const before = page.reports.length;
    socket.fire("cardclickedB", 3, true);
    expect(page.reports).toHaveLength(before);
  });

  it("階段結束時放掉，但不要去動下一個階段的按鈕", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);

    page.setMovePhase(false);
    page.arbiter.tick();
    await ticks(1);

    const released = page.reports.filter((r) => r.type === "ok-released");
    expect(released[0]).toMatchObject({ by: "phase-ended" });
    // ⚠ 不可以把按鈕鎖成不可按 —— 那顆鈕已經屬於攻擊／防禦階段了
    expect(page.ok.interactive).toBe(true);
  });
});

describe("§12：卡片編號不得離開頁面", () => {
  it("回報的是每場重編的流水號，不是遊戲的卡片 ID", () => {
    // 對手的卡片 ID 在翻牌前是隱藏資訊。仲裁只需要「是不是同一張」。
    expect(script).toContain("function opaqueId(seat, id)");
    expect(script).toContain("payload.cardRef = opaqueId(seat, arguments[1])");
    // 不可以直接把原始 id 放進 payload
    expect(script).not.toContain("cardId: arguments[1]");
  });

  it("opaqueId 對同一張牌穩定、對不同牌不同、兩座位互不干擾", () => {
    const body = script.slice(
      script.indexOf("var refs = "),
      script.indexOf("function seatOf(name)"),
    );
    const sandbox: { opaqueId?: (s: string, id: unknown) => number } = {};
    new Script(`${body}\nthis.opaqueId = opaqueId;`).runInNewContext(sandbox);
    const f = sandbox.opaqueId!;

    expect(f("A", 41)).toBe(f("A", 41)); // 同一張牌永遠同一個號
    expect(f("A", 42)).not.toBe(f("A", 41)); // 不同牌不同號
    // 兩邊各自編號 —— A 的 1 號跟 B 的 1 號沒有關係
    expect(f("B", 999)).toBe(1);
    expect(f("A", 41)).toBe(1);
  });

  it("只回報三種操作事件，其餘不外流", () => {
    expect(script).toContain('if (!isClick && !isRotate && n !== "move_select") return;');
  });
});

describe("isOkPatchReport", () => {
  it("認得五種回報", () => {
    for (const type of [
      "ok-intercepted",
      "ok-released",
      "ok-patch-event",
      "ok-patch-installed",
      "ok-patch-error",
    ]) {
      expect(isOkPatchReport({ type })).toBe(true);
    }
  });

  it("擋掉別的模組的回報", () => {
    // 同一個 binding 也收 cost-patch 與 ws-watch 的回報，分流靠這個。
    expect(isOkPatchReport({ type: "ws-event" })).toBe(false);
    expect(isOkPatchReport({ type: "cost-patch" })).toBe(false);
    expect(isOkPatchReport(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WP-15：替玩家按 OK、讀秒顯示、hazard、階段序號
// ---------------------------------------------------------------------------

describe("跑起來：約定秒數（WP-15）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⚠ 玩家沒按 OK 時，forceEnd 要**替他按**，而且真的送得出去", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);

    expect(page.arbiter.forceEnd("arbiter")).toBe("pressed");
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]?.[0]).toBe("I_am_ok");
    // 參數是**遊戲自己組的** —— 插件不知道也不需要知道協定（不變量 3）。
    expect(page.sent[0]?.slice(1)).toEqual(["room-1", "player-1"]);
  });

  it("⚠ 替玩家按的那次不可以被自己攔下來", () => {
    // 沒有 passthrough 旗標的話，遊戲 emit 出來的 I_am_ok 會撞到我們自己的
    // 攔截 —— 「強制送出」變成「強制壓住」，方向剛好相反。
    const page = bootPage();
    page.arbiter.tick();
    page.arbiter.forceEnd("arbiter");
    expect(page.arbiter.held).toBeNull();
    expect(page.sent).toHaveLength(1);
  });

  it("玩家已經按過（正壓著）就是重放，不是再按一次", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    expect(page.sent).toHaveLength(0); // 攔下來了

    expect(page.arbiter.forceEnd("arbiter")).toBe("released");
    expect(page.sent).toHaveLength(1);
  });

  it("⚠ 同一個階段只送一次 —— 否則每個 tick 都會再按一下", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.forceEnd("arbiter");
    expect(page.arbiter.forceEnd("arbiter")).toBe("already-sent");
    expect(page.sent).toHaveLength(1);
  });

  it("不在移動階段就不按 —— 那顆鈕已經屬於下一個階段", async () => {
    const page = bootPage();
    page.arbiter.tick();
    page.setMovePhase(false);
    await ticks(1);
    expect(page.arbiter.forceEnd("arbiter")).toBe("not-in-phase");
    expect(page.sent).toHaveLength(0);
  });

  it("送出後回報 by: forced，讓 CLI 分得出是誰按的", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.forceEnd("arbiter");
    expect(page.reports).toContainEqual({ type: "ok-released", by: "forced", heldMs: 0 });
  });

  it("換階段之後可以再送一次", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.forceEnd("arbiter");

    page.setMovePhase(false);
    await ticks(1);
    page.setMovePhase(true);
    page.arbiter.tick();
    await ticks(1);

    expect(page.arbiter.forceEnd("arbiter")).toBe("pressed");
    expect(page.sent).toHaveLength(2);
  });
});

describe("跑起來：讀秒顯示跟著約定秒數改", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("沒設約定秒數就完全是遊戲原本的畫法", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    expect(page.frame(30)).toEqual({ text: "30", scaleX: 1, fill: 240 });
  });

  it("約定 15 秒 → 剩 30 秒時畫成 15，剩 15 秒時畫成 0", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.setDisplayCap(15);

    expect(page.frame(30).text).toBe("15");
    expect(page.frame(22.5).text).toBe("7.5");
    // 歸零時遊戲印的就是 "0"（`(0).toPrecision(1)`），照抄。
    expect(page.frame(15).text).toBe("0");
  });

  it("⚠ 讀秒條要**提早變紅** —— 這正是玩家要的那件事", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);

    // 沒縮短時剩 20 秒還很藍（240 是藍、0 是紅）。
    expect(page.frame(20).fill).toBe(160);
    // 約定 15 秒之後，同樣的剩 20 秒已經只剩 1/3 —— 顏色明顯往紅走。
    page.arbiter.setDisplayCap(15);
    expect(page.frame(20).fill).toBe(80);
    expect(page.frame(16).fill).toBe(16);
  });

  it("條子的長度也跟著縮，而且留著遊戲原本的最小長度", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.setDisplayCap(15);
    expect(page.frame(15).scaleX).toBeCloseTo(0.066, 5);
    expect(page.frame(30).scaleX).toBeCloseTo(1, 5);
  });

  it("⚠ 改的只有畫面 —— 真正的剩餘秒數不受影響", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.setDisplayCap(15);
    page.frame(22.5);
    // 硬底線讀的是這個。跟著畫面走的話它會提早 15 秒觸發。
    expect(page.arbiter.tick().remaining).toBe(22.5);
  });

  it("設回 null 就還原", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.setDisplayCap(15);
    page.arbiter.setDisplayCap(null);
    expect(page.frame(30)).toEqual({ text: "30", scaleX: 1, fill: 240 });
  });

  it("⚠ 拆 patch 一定要把顯示還原，不能留一個沒人維護的假倒數", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.setDisplayCap(15);
    page.arbiter.uninstall("uninstall");
    expect(page.frame(30)).toEqual({ text: "30", scaleX: 1, fill: 240 });
  });
});

describe("跑起來：hazard（聖水 + 場上狀態）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * ⚠ **狀態一律用 setStatuses（讀畫面），不要再用 state 事件。**
   *
   * 2026-08-10 改掉的：舊版靠 state 事件自己數回合，而那在結構上就不可能對
   * （伺服器解除時什麼都不送、自壞與其他狀態減回合的時機不同、漏一次就永遠
   * 偏掉）。玩家連續回報的「剩 2 縮短、剩 1 不縮短」就是這麼來的。
   *
   * 現在讀的是遊戲自己畫出來的圖示與數字，所以測試也要照那個形狀給。
   */

  it("只有聖水、沒有場上狀態 → 不算", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([0, 91]);
    expect(page.arbiter.tick().hazard).toBe(false);
  });

  it("只有麻痺、手牌沒聖水 → 不算", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setStatuses([{ key: "mahi", turns: 2 }]);
    expect(page.arbiter.tick().hazard).toBe(false);
  });

  it("兩個都有 → 算", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([0, 91]);
    page.setStatuses([{ key: "mahi", turns: 2 }]);
    expect(page.arbiter.tick().hazard).toBe(true);
  });

  it("聖杯（94）與毒杯（95）也算", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setStatuses([{ key: "mahi", turns: 1 }]);
    page.setHand([94]);
    expect(page.arbiter.tick().hazard).toBe(true);
    page.setHand([95]);
    expect(page.arbiter.tick().hazard).toBe(true);
  });

  it("⚠ 自壞剩 2~4 回合不算，剩 1 回才算（玩家 2026-08-09 指定）", async () => {
    // 把規格書原本就寫的「剩一回自壞」補回來 —— 自壞還有好幾回合時跟拖時間
    // 無關，要到剩最後一回合那一回合的決策才真的變重。
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([91]);

    for (const turns of [4, 3, 2]) {
      page.setStatuses([{ key: "jikai", turns }]);
      expect(page.arbiter.tick().hazard).toBe(false);
    }
    page.setStatuses([{ key: "jikai", turns: 1 }]);
    expect(page.arbiter.tick().hazard).toBe(true);
  });

  it("麻痺與降低移動沒有「剩一回」的分別，1~9 都算", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([91]);
    for (const turns of [1, 3, 9]) {
      page.setStatuses([{ key: "mahi", turns }]);
      expect(page.arbiter.tick().hazard).toBe(true);
      page.setStatuses([{ key: "movD", turns }]);
      expect(page.arbiter.tick().hazard).toBe(true);
    }
  });

  it("⚠ frame 名帶數值也要認得（atkD3 那種寫法）", async () => {
    // 實測 frame 名有時後面接一個數值：atkD3 = 攻擊力 -3、defD3 = 防禦力 -3。
    // 所以比對要用前綴，而 movD 這種鍵才不會漏掉帶數值的版本。
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([91]);
    page.setStatuses([{ key: "movD3", turns: 2 }]);
    expect(page.arbiter.tick().hazard).toBe(true);
  });

  it("⚠ 前綴比對不可以誤中別的狀態鍵", async () => {
    // atkD / defD / movB 都不在清單裡，不能因為長得像就算進去。
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([91]);
    page.setStatuses([
      { key: "atkD3", turns: 1 },
      { key: "defD3", turns: 1 },
      { key: "movB2", turns: 1 },
      { key: "poison", turns: 3 },
    ]);
    expect(page.arbiter.tick().hazard).toBe(false);
  });

  it("⚠ 狀態從畫面上消失就立刻不算 —— 這是改讀畫面的全部理由", async () => {
    // 玩家用聖水解掉麻痺時，伺服器**一則事件都不送**（錄 441 秒實證）。
    // 靠事件數回合的版本會留下幽靈，5 秒永遠加不回來；讀畫面則是自動正確。
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([91, 94]);
    page.setStatuses([{ key: "mahi", turns: 3 }]);
    expect(page.arbiter.tick().hazard).toBe(true);

    // 解掉了：畫面上的圖示不見（手上還有一張聖水，所以另一半仍然成立）
    page.setStatuses([]);
    expect(page.arbiter.tick().hazard).toBe(false);
  });

  it("讀不到就當成沒有，不要亂縮短", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.setHand([91]);
    expect(page.arbiter.tick().hazard).toBe(false);
  });
});

describe("跑起來：階段序號與準備開關", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⚠ 每進入一次移動階段才 +1，不是每個 tick 都加", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(5);
    const first = page.arbiter.tick().phaseId;

    page.setMovePhase(false);
    await ticks(3);
    page.setMovePhase(true);
    await ticks(3);
    expect(page.arbiter.tick().phaseId).toBe(first + 1);
  });

  it("關掉準備功能就完全不攔，但 patch 還在（約定秒數還要用）", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    page.arbiter.setHold(false);

    pressOk(page);
    expect(page.sent).toHaveLength(1); // 直接送出去了
    expect(page.arbiter.tick().hold).toBe(false);
    // patch 還活著 —— forceEnd 這條路照樣要能用。
    expect(page.arbiter.tick().armed).toBe(true);
  });

  it("⚠ 關掉的當下如果正壓著東西，要立刻放掉", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    expect(page.sent).toHaveLength(0);

    page.arbiter.setHold(false);
    expect(page.sent).toHaveLength(1);
    expect(page.arbiter.held).toBeNull();
  });
});
