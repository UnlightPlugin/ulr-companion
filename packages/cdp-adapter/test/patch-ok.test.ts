import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OK_BUTTON, WS_CLIENT } from "../src/constants.js";
import type { OkPatchReport } from "../src/patch-ok.js";
import { buildOkPatchScript, isOkPatchReport, OK_PATCH_GLOBAL } from "../src/patch-ok.js";

const script = buildOkPatchScript({ bindingName: "__test_binding" });

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
    // engaged 還多含了「攔截真的掛著」與「Node 還活著」：Node 死掉之後畫面
    // 不該繼續宣稱一個已經不存在的保護。
    expect(script).toContain("var engaged = inPhase && state.armed && alive;");
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
    // 放行是安全的；攔錯階段會拖慢玩家。函式裡有兩條 return false：
    // 一條是「不在清單裡」，一條是 catch。
    const start = script.indexOf("function inInterceptPhase()");
    const body = script.slice(start, script.indexOf("function nodeAlive()", start));
    expect(body.match(/return false/g)).toHaveLength(2);
  });

  it("⚠ Node 沒心跳就不要攔 —— 攔了沒人管比不攔糟得多", () => {
    // companion 結束之後頁面上的 patch 還活著的話，它會變成一把沒有鑰匙的鎖：
    // 照攔不誤，但沒有人能下 cancel／release，玩家每個移動階段被壓滿 25 秒
    // 而且取消不了（2026-08-03 實測）。不攔只是功能沒生效，是安全的那一邊。
    expect(script).toContain("return state.armed && nodeAlive() && inInterceptPhase();");
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
    tick(): { remaining: number | null; armed: boolean; seat: string | null };
    release(by: string): string;
    cancel(): string;
    uninstall(why?: string): string;
    setOkFrame(frame: string, interactive?: boolean): boolean;
    held: unknown;
    armed: boolean;
  };
  /** 換一顆 socket（重新開房）。 */
  swapSocket(): FakeSocket;
  /** 連線建好（本來還在大廳）。 */
  attachSocket(): FakeSocket;
  setMovePhase(active: boolean): void;
}

const BINDING = "__test_binding";

function bootPage(options: { withSocket?: boolean } = {}): Page {
  const { sent, makeSocket } = makeSocketWorld();
  const ok = new FakeOkButton();
  ok.installGameHover();
  const reports: OkPatchReport[] = [];

  const timer = { type: "BitmapText", x: 380, y: 318, visible: true, text: "30" };
  const mainA: Record<string, unknown> = {
    ok,
    PLAYER: "A",
    socket: options.withSocket === false ? undefined : makeSocket(),
    sys: { settings: { active: true } },
  };
  const movePhaseA = {
    sys: { settings: { active: true } },
    children: { list: [timer] },
  };
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
  sandbox["window"] = {
    game: { scene: { keys: scenes } },
    [BINDING]: (json: string) => reports.push(JSON.parse(json) as OkPatchReport),
  };

  const status: unknown = new Script(script).runInNewContext(sandbox);
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
      movePhaseA.sys.settings.active = active;
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

  it("⚠ Node 斷了要主動放掉，不要等 25 秒的失效保護", async () => {
    const page = bootPage();
    page.arbiter.tick();
    await ticks(1);
    pressOk(page);
    expect(page.arbiter.held).not.toBeNull();

    // 心跳停了。staleMs 是 3 秒，遠早於 25 秒。
    await ticks(20);

    expect(page.sent).toHaveLength(1);
    const released = page.reports.filter((r) => r.type === "ok-released");
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ by: "node-gone" });
    expect(page.ok.tint).toBeNull(); // 染色也要收掉，別再宣稱有保護
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
