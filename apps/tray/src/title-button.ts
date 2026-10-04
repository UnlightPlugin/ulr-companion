/**
 * 標題列「重新整理」鈕的 Electron 那一半。為什麼這樣做見 `title-button-core.ts`。
 *
 * 生命週期跟著**遊戲的程序**走，不跟著 CDP 連線走：白畫面、重載空檔時引擎會
 * 斷線重連，但遊戲視窗還在，鈕也該在。`attach(pid)` 同一個 pid 重複呼叫不做事；
 * 遊戲視窗消失 helper 自己結束，下次接上遊戲再 `attach`。
 *
 * ## 休眠恢復後整個重建
 *
 * 2026-09-27 玩家回報：從休眠恢復後鈕停在一塊深灰（取色沒跟上標題列）、按了也
 * 沒反應。實測當時托盤主視窗畫得好好的、鈕的視窗也還貼在對的位置、helper 也活著，
 * 但**鈕那個視窗的 Chromium 不再出畫面** —— 顏色與圖示停住，點擊也到不了頁面
 * （記錄裡一次按鈕都沒有，不是 reload 失敗）。從外面對它 hide／show、改大小都救
 * 不回來。所以休眠恢復、解鎖螢幕、renderer 掛掉或沒回應時，把視窗連同 helper
 * 整個丟掉重開一份（新的 HWND 要重新交給 helper）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import { BrowserWindow, powerMonitor } from "electron";

import {
  buildTitleButtonScript,
  FALLBACK_TITLE_BG,
  parseTitleButtonLine,
  titleButtonLook,
  type TitleButtonEvent,
} from "./title-button-core.js";

/** 鈕的頁面按下去會導向這個網址；主程序在 will-navigate 攔下來。 */
const CLICK_URL = "https://ulr.invalid/title-button/reload";

/** 連點保護：重新整理之後這段時間內再按不理。 */
const CLICK_COOLDOWN_MS = 3_000;

/**
 * 休眠恢復後等一下再重建：剛醒來 GPU 與顯示器還在重新初始化，馬上開的視窗可能
 * 又畫不出來。連續幾個事件（resume、unlock-screen）併成一次。
 */
const REBUILD_DELAY_MS = 3_000;

export interface TitleButtonOptions {
  rendererDir: string;
  onClick: () => void;
  log: (line: string) => void;
  /** 不帶 ELECTRON_RUN_AS_NODE 之類的環境變數（見 cdp-adapter 的 ENV_KEYS_TO_STRIP）。 */
  env: NodeJS.ProcessEnv;
}

export class TitleButton {
  readonly #options: TitleButtonOptions;
  #win: BrowserWindow | null = null;
  #helper: ChildProcessWithoutNullStreams | null = null;
  #pid: number | null = null;
  #bg: string | null = null;
  #active = false;
  #everShown = false;
  #lastClick = 0;
  #rebuildTimer: NodeJS.Timeout | null = null;
  readonly #onWake = (): void => this.#rebuildSoon("從休眠恢復");

  constructor(options: TitleButtonOptions) {
    this.#options = options;
    powerMonitor.on("resume", this.#onWake);
    powerMonitor.on("unlock-screen", this.#onWake);
  }

  /** 把鈕貼到 `pid` 那個程序的主視窗上。已經貼著同一個就不動。 */
  attach(pid: number): void {
    if (process.platform !== "win32") return;
    if (this.#pid === pid && this.#helper !== null) return;
    this.detach();
    this.#pid = pid;

    const win = this.#ensureWindow();
    let script: string;
    try {
      script = buildTitleButtonScript(pid, win.getNativeWindowHandle().readBigUInt64LE(0));
    } catch (err) {
      this.#options.log(`✗ 標題列按鈕裝不上：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const encoded = Buffer.from(`${script}\n`, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { env: this.#options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#helper = child;

    let buffered = "";
    child.stdout.on("data", (d: Buffer) => {
      buffered += d.toString("utf8");
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const ev = parseTitleButtonLine(line);
        if (ev !== null) this.#onEvent(ev);
      }
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      // PowerShell 在 stdout 被導走時會把進度訊息以 CLIXML 丟到 stderr，不是錯誤
      const text = d.toString("utf8");
      if (!text.startsWith("#< CLIXML")) stderr += text;
    });
    child.on("error", (err) => this.#options.log(`✗ 標題列按鈕的 helper 起不來：${err.message}`));
    child.on("close", (code) => {
      if (this.#helper !== child) return;
      this.#helper = null;
      this.#pid = null;
      this.#win?.hide();
      if (code !== 0 && stderr.trim() !== "") {
        this.#options.log(`✗ 標題列按鈕的 helper 結束了：${stderr.trim().slice(0, 200)}`);
      }
    });
  }

  /** 拿掉鈕、收 helper。視窗留著下次用。 */
  detach(): void {
    const child = this.#helper;
    this.#helper = null;
    this.#pid = null;
    if (child !== null) child.kill();
    this.#win?.hide();
  }

  /** 結束程式時呼叫。 */
  dispose(): void {
    powerMonitor.off("resume", this.#onWake);
    powerMonitor.off("unlock-screen", this.#onWake);
    if (this.#rebuildTimer !== null) clearTimeout(this.#rebuildTimer);
    this.#rebuildTimer = null;
    this.detach();
    this.#destroyWindow();
  }

  /** 見檔頭「休眠恢復後整個重建」。沒貼著遊戲時只丟掉視窗，下次 `attach` 自然開新的。 */
  #rebuildSoon(reason: string): void {
    if (this.#rebuildTimer !== null) return;
    this.#rebuildTimer = setTimeout(() => {
      this.#rebuildTimer = null;
      const pid = this.#pid;
      this.detach();
      this.#destroyWindow();
      if (pid === null) return;
      this.#options.log(`· 標題列按鈕重新裝上（${reason}）`);
      this.attach(pid);
    }, REBUILD_DELAY_MS);
  }

  #destroyWindow(): void {
    const win = this.#win;
    this.#win = null;
    if (win !== null && !win.isDestroyed()) win.destroy();
  }

  #onEvent(ev: TitleButtonEvent): void {
    switch (ev.type) {
      case "state":
        this.#active = ev.active;
        if (ev.bg !== null) this.#bg = ev.bg;
        this.#paint();
        // helper 用 SetWindowPos 顯示；第一次讓 Electron 自己也知道它是顯示著的，
        // 否則它以為視窗是藏著的，可能不畫。
        if (ev.shown && !this.#everShown && this.#win !== null) {
          this.#everShown = true;
          this.#win.showInactive();
        }
        return;
      case "gone":
        return;
      case "error":
        this.#options.log(`✗ 標題列按鈕：${ev.message}`);
        return;
    }
  }

  #paint(): void {
    const win = this.#win;
    if (win === null || win.isDestroyed()) return;
    const look = titleButtonLook(this.#bg, this.#active);
    win.setBackgroundColor(look.bg);
    void win.webContents
      .executeJavaScript(`window.ulrLook && window.ulrLook(${JSON.stringify(look)})`)
      .catch(() => {});
  }

  #ensureWindow(): BrowserWindow {
    if (this.#win !== null && !this.#win.isDestroyed()) return this.#win;
    const win = new BrowserWindow({
      width: 46,
      height: 30,
      show: false,
      frame: false,
      // ⚠ 不能用 transparent：Chromium 會把小於 64px 的透明視窗偷偷放大，外面再
      // 貼成 48×30 大小就算錯（見 title-button-core.ts「底色是從螢幕上取的」）。
      backgroundColor: FALLBACK_TITLE_BG,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 不搶焦點：按它不能讓遊戲視窗失去前景（WS_EX_NOACTIVATE）
      focusable: false,
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    win.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (url !== CLICK_URL) return;
      const now = Date.now();
      if (now - this.#lastClick < CLICK_COOLDOWN_MS) return;
      this.#lastClick = now;
      void win.webContents.executeJavaScript("window.ulrSpin && window.ulrSpin()").catch(() => {});
      this.#options.onClick();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("did-finish-load", () => this.#paint());
    // 頁面沒了就沒人接點擊，鈕還貼著卻按不動 —— 跟休眠恢復一樣重開一份。
    // 自己 destroy 掉的舊視窗不算。
    win.webContents.on("render-process-gone", (_event, details) => {
      if (this.#win === win) this.#rebuildSoon(`畫面程序結束了：${details.reason}`);
    });
    win.webContents.on("unresponsive", () => {
      if (this.#win === win) this.#rebuildSoon("畫面程序沒有回應");
    });
    win.on("closed", () => {
      if (this.#win === win) this.#win = null;
    });
    void win.loadFile(join(this.#options.rendererDir, "title-button.html"));
    this.#win = win;
    this.#everShown = false;
    return win;
  }
}
