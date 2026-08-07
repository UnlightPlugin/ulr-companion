/**
 * 渲染層唯一能碰到的東西
 * ========================
 * §12：畫面拿不到 Node、拿不到檔案系統、也拿不到遊戲。它只能問狀態、
 * 送設定、動配置清單。介面越小，「畫面被塞了一段別人的腳本」的後果越小。
 *
 * ⚠ **不要在這裡加一個通用的 `invoke(channel, ...args)`。** 那等於把整個
 * ipcMain 攤開給渲染層，上面那句話就不成立了。每加一個功能就明確加一個方法。
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ulr", {
  /** 拿一份完整快照。開視窗時叫一次。 */
  state: () => ipcRenderer.invoke("ulr:state"),
  /** 改設定，回傳新的快照。 */
  setPrefs: (prefs: Record<string, unknown>) => ipcRenderer.invoke("ulr:set-prefs", prefs),
  /** 狀態變了就會被叫。主程序**每次都送整份**，畫的人不必自己合併。 */
  onState: (handler: (snapshot: unknown) => void) => {
    ipcRenderer.on("ulr:state", (_event, snapshot: unknown) => handler(snapshot));
  },

  /** 配置清單。多開的骨架，見 `profiles.ts`。 */
  profiles: {
    add: (from?: string) => ipcRenderer.invoke("ulr:profile-add", from),
    remove: (id: string) => ipcRenderer.invoke("ulr:profile-remove", id),
    edit: (id: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke("ulr:profile-edit", id, patch),
    defaultPort: (kind: string) => ipcRenderer.invoke("ulr:profile-default-port", kind),
    /** 開一個綁在這份配置上的新視窗（＝多開）。 */
    launch: (id: string) => ipcRenderer.invoke("ulr:profile-launch", id),
  },

  /** 換準備中的染色。`null` = 不染色（官方原本的樣子）。 */
  setReadyTint: (tint: number | null) => ipcRenderer.invoke("ulr:set-tint", tint),

  /** 開機啟動那組全域選項。 */
  setOptions: (patch: Record<string, unknown>) => ipcRenderer.invoke("ulr:options", patch),

  /** 開外部連結。主程序那端有白名單。 */
  openExternal: (url: string) => ipcRenderer.invoke("ulr:open-external", url),
});
