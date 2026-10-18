/**
 * 托盤「設置 › 網頁版」：帶除錯埠開瀏覽器、桌面捷徑／.cmd、Steam 登入擴充（2026-10-18 從
 * main.ts 搬出來，程式照原樣）。
 *
 * 會用到 electron（shell、clipboard、dialog、app.getPath），所以不放在 `pages/`（那裡只能
 * `import type` electron，測試在 Node 裡跑）。
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, clipboard, dialog, shell } from "electron";
import type { BrowserWindow } from "electron";
import {
  BrowserNotFoundError,
  browserDebugPort,
  buildBrowserLaunchCmd,
  buildBrowserShortcutArgs,
  ensureBrowser,
  findBrowser,
  loadExtensionArgs,
} from "@ulr/cdp-adapter";
import { clientLabel, userDataDirFor } from "./profiles.js";
import type { IpcHandle, TrayContext } from "./tray-context.js";
import { exportExtension, extVersion, STEAM_EXT_DIR, STEAM_EXT_GUIDE_URL } from "./web-client.js";

/** 一族瀏覽器帶除錯埠開的方式。`target` = 捷徑「目標」欄整行；沒裝就是 `null`。 */
export interface BrowserSetup {
  exe: string | null;
  profileDir: string;
  args: string;
  target: string | null;
}

/** 安裝包帶的 Steam 登入擴充原始檔（`scripts/build-tray.mjs` 把 assets 整包複製過去）。 */
const STEAM_EXT_SRC = join(__dirname, "assets", "steam-login-extension");
const STEAM_EXT_BUNDLED = extVersion(STEAM_EXT_SRC);
/** 玩家那邊放著哪一版。快照很常送，不每次讀檔 —— 開機讀一次、放好之後更新。 */
let steamExtInstalled = extVersion(STEAM_EXT_DIR);

/**
 * 給快照用：Steam 登入擴充放在哪、那裡現在是哪一版、安裝包帶的是哪一版。
 * `installed` 跟 `bundled` 不一樣 = 按一下「放好」就會更新。
 */
export function steamExtState(): {
  dir: string;
  installed: string | null;
  bundled: string | null;
  guideUrl: string;
} {
  return {
    dir: STEAM_EXT_DIR,
    installed: steamExtInstalled,
    bundled: STEAM_EXT_BUNDLED,
    guideUrl: STEAM_EXT_GUIDE_URL,
  };
}

/**
 * 哪一族啟動時要臨時掛 Steam 登入擴充：只有 Edge，而且要已經放好。理由見 `loadExtensionArgs`。
 * manifest 帶 key，臨時掛上的 ID 跟手動載入的一樣，存的 Steam 帳號不會因此不見。
 */
function autoLoadExtDir(family: "chrome" | "edge"): string | null {
  return family === "edge" && steamExtInstalled !== null ? STEAM_EXT_DIR : null;
}

/**
 * 這一族瀏覽器在這台機器上怎麼帶除錯埠開：網頁版教學頁照這個畫「捷徑目標」，
 * 桌面捷徑也照這個寫。`exe === null` = 沒裝（或裝在找不到的地方）。
 *
 * 執行檔開機找一次就好 —— 快照很常送，而裝新瀏覽器之後重開插件不算過分。
 */
const browserExe = {
  chrome: findBrowser(process.env, "chrome")?.path ?? null,
  edge: findBrowser(process.env, "edge")?.path ?? null,
};

export function browserSetup(family: "chrome" | "edge"): BrowserSetup {
  const exe = browserExe[family];
  const profileDir = userDataDirFor(family);
  const args = buildBrowserShortcutArgs(profileDir, autoLoadExtDir(family));
  return { exe, profileDir, args, target: exe === null ? null : `"${exe}" ${args}` };
}

/** 網頁版那一頁另外要的東西（main.ts 給）。 */
export interface WebPageDeps {
  /** 設定視窗（另存 .cmd 的對話框掛在它上面）；還沒開是 null。 */
  window(): BrowserWindow | null;
}

export function registerWebPage(ipc: IpcHandle, ctx: TrayContext, deps: WebPageDeps): void {
  /** 瀏覽器那一族。桌面版沒有這些按鈕，按到了也不做事。 */
  const browserFamily = (): "chrome" | "edge" | null =>
    ctx.profile.kind === "chrome" || ctx.profile.kind === "edge" ? ctx.profile.kind : null;

  /**
   * 用插件專用的 profile 開瀏覽器，帶 `--remote-debugging-port=0`。
   * 已經開著（而且有除錯埠）就不重開 —— 玩家可能正在裡面打。
   *
   * `family` 可以跟這份配置接的客戶端不同（設置 › 啟動 那兩顆鈕）：開出來的是
   * 那一族自己的 profile，插件不一定接它，給 Moon 之類的外部腳本用。
   */
  async function openBrowser(family: "chrome" | "edge", extPage: string | null) {
    try {
      const r = await ensureBrowser({
        family,
        // 只拿來問「是不是已經開著」—— `alwaysAutoPort` 一律用 `=0` 開，而判斷
        // 「開著」時檔案（profileDir 的 DevToolsActivePort）優先於這個埠。
        port: browserDebugPort(family),
        profileDir: userDataDirFor(family),
        alwaysAutoPort: true,
        // Edge 每次啟動都臨時掛上 Steam 登入擴充（見 loadExtensionArgs）。資料夾裡沒有
        // 擴充就不帶，照常開。
        ...(autoLoadExtDir(family) !== null ? { extraArgs: loadExtensionArgs(STEAM_EXT_DIR) } : {}),
        startUrl: extPage,
        onNotice: (m) => ctx.log(`· ${m}`),
      });
      // 已經開著：再叫一次同一個 profile，網址會交給那個實例開成新分頁。
      if (!r.launched && extPage !== null) {
        const exe = findBrowser(process.env, family);
        if (exe !== null) {
          const env = { ...process.env };
          delete env["ELECTRON_RUN_AS_NODE"];
          spawn(exe.path, [`--user-data-dir=${r.profileDir}`, extPage], {
            detached: true,
            stdio: "ignore",
            env,
          }).unref();
        }
      }
      const label = clientLabel(family);
      ctx.log(`· ${label}${r.launched ? "已開啟" : "已經開著"}（除錯埠 :${r.port}）`);
      return { ok: true, text: `${label} ${r.launched ? "已開啟" : "已經開著"}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log(`⚠ 開 ${clientLabel(family)} 失敗：${msg.split("\n")[0]}`);
      return {
        ok: false,
        text:
          e instanceof BrowserNotFoundError
            ? `找不到 ${clientLabel(family)}`
            : "開了，但沒有除錯埠 —— 這個設定檔的視窗可能已經開著。全部關掉再按一次。",
      };
    }
  }

  ipc.handle("ulr:browser-open", async (_event, page?: unknown) => {
    const family = browserFamily();
    if (family === null) return { ok: false, text: "" };
    // 只收一個固定值：渲染層不能叫我們開任意網址（同 open-external 的原則）。
    return openBrowser(family, page === "extensions" ? `${family}://extensions` : null);
  });

  /**
   * 指定哪一族開，跟這份配置接哪種客戶端無關。只收 chrome／edge；
   * `page` 只收 `"extensions"`（裝 Steam 登入擴充那一步）。
   */
  ipc.handle("ulr:browser-launch", async (_event, raw: unknown, page?: unknown) => {
    if (raw !== "chrome" && raw !== "edge") return { ok: false, text: "" };
    return openBrowser(raw, page === "extensions" ? `${raw}://extensions` : null);
  });

  /**
   * 在桌面放一個帶除錯埠的捷徑。內容跟教學頁上那行「目標」一字不差
   * （同一個 `browserSetup()`）。同名的直接蓋掉 —— 旗標改了再按一次就是更新。
   */
  ipc.handle("ulr:browser-shortcut", async (_event, raw: unknown) => {
    if (raw !== "chrome" && raw !== "edge") return { ok: false, text: "" };
    const s = browserSetup(raw);
    if (s.exe === null) return { ok: false, text: `找不到 ${clientLabel(raw)}` };
    const name = `ULR ${clientLabel(raw)}`;
    const lnk = join(app.getPath("desktop"), `${name}.lnk`);
    const ok = shell.writeShortcutLink(lnk, "create", {
      target: s.exe,
      args: s.args,
      cwd: dirname(s.exe),
      icon: s.exe,
      iconIndex: 0,
      description: `${clientLabel(raw)}（帶除錯埠，ULR Companion 用）`,
    });
    ctx.log(ok ? `· 桌面捷徑：${lnk}` : `⚠ 寫不出桌面捷徑：${lnk}`);
    return ok
      ? { ok: true, text: `桌面多了「${name}」` }
      : { ok: false, text: "寫不出捷徑 —— 桌面資料夾可能被防毒或權限擋住。" };
  });

  /** 把捷徑「目標」整行放進剪貼簿。字串由主程序決定（同 `copy-debug-flag`）。 */
  ipc.handle("ulr:browser-copy-target", async (_event, raw: unknown) => {
    if (raw !== "chrome" && raw !== "edge") return { ok: false, text: "" };
    const t = browserSetup(raw).target;
    if (t === null) return { ok: false, text: `找不到 ${clientLabel(raw)}` };
    clipboard.writeText(t);
    return { ok: true, text: "已複製" };
  });

  /** 同一件事存成 .cmd，給想放捷徑、或不開插件也要開的人。 */
  ipc.handle("ulr:browser-save-cmd", async () => {
    const family = browserFamily();
    if (family === null) return { ok: false, text: "" };
    const owner = deps.window();
    const opts = {
      defaultPath: join(app.getPath("desktop"), `ULR-${clientLabel(ctx.profile.kind)}.cmd`),
      filters: [{ name: "cmd", extensions: ["cmd"] }],
    };
    const r = await (owner === null
      ? dialog.showSaveDialog(opts)
      : dialog.showSaveDialog(owner, opts));
    if (r.canceled || r.filePath === undefined) return { ok: false, text: "" };
    writeFileSync(r.filePath, buildBrowserLaunchCmd(family), "ascii");
    return { ok: true, text: `已存到 ${r.filePath}` };
  });

  /** 把 Steam 登入擴充放到 `STEAM_EXT_DIR`，打開那個資料夾。 */
  ipc.handle("ulr:steam-ext-install", async () => {
    try {
      const r = exportExtension(STEAM_EXT_SRC, STEAM_EXT_DIR);
      steamExtInstalled = r.version;
      ctx.log(`· Steam 登入擴充 ${r.version ?? "?"} 放到 ${r.dir}`);
      void shell.openPath(r.dir);
      ctx.pushState();
      return { ok: true, text: "已放好" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log(`⚠ 放 Steam 登入擴充失敗：${msg}`);
      return { ok: false, text: msg };
    }
  });
}
