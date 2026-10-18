/**
 * 托盤各頁的設定處理器共用的那一小撮東西
 * ========================================
 * 渦／任務／迪城／獎勵那幾頁的 IPC 處理器（`pages/*.ts`）以前全部寫在 main.ts 的
 * `app.whenReady` 裡，每個開關都是同一套五行：改 profile、非臨時配置才存檔、推給
 * engine、寫記錄、pushState。2026-10-18 拆出來時把前兩步收成 {@link TrayContext.patchProfile}。
 *
 * ⚠ `profile` 與 `engine` 是**讀當下的值**（main.ts 那邊是 getter）：切換配置、
 * 遊戲重接都會換掉它們，處理器不能把它們存起來用。
 *
 * ⚠ 這支（與 `pages/*.ts`）只能 `import type` electron —— 測試在 Node 裡跑。
 */

import type { ArbiterEngine } from "@ulr/arbiter-engine";
import type { IpcMain } from "electron";
import type { Profile } from "./profiles-core.js";

export interface TrayContext {
  /** 現在這份配置。 */
  readonly profile: Profile;
  /** 接著遊戲的引擎；還沒接上是 null。 */
  readonly engine: ArbiterEngine | null;
  /** 改這份配置：先改記憶體，不是命令列臨時建的配置才寫回設定檔。 */
  patchProfile(patch: Partial<Omit<Profile, "id">>): void;
  log(line: string): void;
  /** 把新的快照推給托盤視窗。 */
  pushState(): void;
}

/** 只用到 `handle`；測試塞一個收集處理器的假貨。 */
export type IpcHandle = Pick<IpcMain, "handle">;
