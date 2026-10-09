/**
 * 標題列「重新整理」鈕的 Electron 那一半：開 helper、聽它說「按了」。鈕本身是
 * helper 自己開、自己畫的原生視窗，為什麼這樣做見 `title-button-core.ts`。
 *
 * 生命週期跟著**遊戲的程序**走，不跟著 CDP 連線走：白畫面、重載空檔時引擎會
 * 斷線重連，但遊戲視窗還在，鈕也該在。`attach(pid)` 同一個 pid 重複呼叫不做事；
 * 遊戲視窗消失 helper 自己結束，下次接上遊戲再 `attach`。
 *
 * 以前鈕是托盤的 BrowserWindow，休眠醒來後 Chromium 不出畫面、按不動，醒來時
 * 整個重建也救不回來（2026-10-05）。改成原生視窗後不用再管休眠。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  parseTitleButtonLine,
  titleButtonLaunch,
  type TitleButtonEvent,
} from "./title-button-core.js";

export interface TitleButtonOptions {
  /** 鈕被按了（連點保護 helper 已經做掉）。 */
  onClick: () => void;
  log: (line: string) => void;
  /** 不帶 ELECTRON_RUN_AS_NODE 之類的環境變數（見 cdp-adapter 的 ENV_KEYS_TO_STRIP）。 */
  env: NodeJS.ProcessEnv;
}

export class TitleButton {
  readonly #options: TitleButtonOptions;
  #helper: ChildProcessWithoutNullStreams | null = null;
  #pid: number | null = null;

  constructor(options: TitleButtonOptions) {
    this.#options = options;
  }

  /** 把鈕貼到 `pid` 那個程序的主視窗上。已經貼著同一個就不動。 */
  attach(pid: number): void {
    if (process.platform !== "win32") return;
    if (this.#pid === pid && this.#helper !== null) return;
    this.detach();

    let launch: { args: string[]; stdin: string };
    try {
      launch = titleButtonLaunch(pid);
    } catch (err) {
      this.#options.log(`✗ 標題列按鈕裝不上：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.#pid = pid;
    const child = spawn("powershell.exe", launch.args, {
      env: this.#options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#helper = child;
    child.stdin.on("error", () => {}); // 起不來時寫 stdin 會 EPIPE；起不來由下面的 error 回報
    child.stdin.end(launch.stdin);

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
      if (code !== 0 && stderr.trim() !== "") {
        this.#options.log(`✗ 標題列按鈕的 helper 結束了：${stderr.trim().slice(0, 200)}`);
      }
    });
  }

  /** 拿掉鈕：鈕的視窗是 helper 的，收掉 helper 它就跟著消失。 */
  detach(): void {
    const child = this.#helper;
    this.#helper = null;
    this.#pid = null;
    if (child !== null) child.kill();
  }

  /** 結束程式時呼叫。 */
  dispose(): void {
    this.detach();
  }

  #onEvent(ev: TitleButtonEvent): void {
    switch (ev.type) {
      case "click":
        this.#options.onClick();
        return;
      case "gone":
        return;
      case "error":
        this.#options.log(`✗ 標題列按鈕：${ev.message}`);
        return;
    }
  }
}
