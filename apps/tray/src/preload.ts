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

  /**
   * 自訂 COST。
   *
   * ⚠ 沒有 `set(path)` —— 路徑一律由主程序的檔案選擇框產生。渲染層能自己指定
   * 讀哪個檔的話，「畫面碰不到檔案系統」那條就破了。
   */
  cost: {
    /** 開檔案選擇框選規則檔。取消的話回傳原本的快照。 */
    pick: () => ipcRenderer.invoke("ulr:cost-pick"),
    /** 停用自訂 COST，回原版數字。 */
    clear: () => ipcRenderer.invoke("ulr:cost-clear"),
    /** 重載遊戲讓注入生效。⚠ 會打斷對戰。 */
    reload: () => ipcRenderer.invoke("ulr:cost-reload"),
  },

  /**
   * 編輯 COST。
   *
   * ⚠ 這一組刻意**不含任何路徑參數**。`save` 寫的一律是「目前選著的那份規則檔」
   * ——渲染層能指定寫哪個檔的話，「畫面碰不到檔案系統」那條就破了。要換檔案
   * 請走 `cost.pick()` 的檔案選擇框。
   *
   * `load` 沒有併進快照是刻意的：四張表加起來 1186 筆，而快照**每次狀態變動都
   * 整份重送**。塞進去的話，光是連線心跳就會在 IPC 上搬一份 COST 表。
   */
  editor: {
    /** 目前規則的四張表 + 卡片名冊。開編輯頁時叫一次。 */
    load: () => ipcRenderer.invoke("ulr:editor-load"),
    /** 存回目前的規則檔。`tables` 是四張表，`version` 可以順便改。 */
    save: (payload: Record<string, unknown>) => ipcRenderer.invoke("ulr:editor-save", payload),
    /** 從跑著的遊戲重讀一份名冊（中文名 + 原價）。 */
    refreshCatalog: () => ipcRenderer.invoke("ulr:editor-catalog"),
  },

  /**
   * 配對。
   *
   * ⚠ `open` / `join` / `cancel` **會替玩家操作遊戲** —— 開房消耗 AP、進房直接
   * 開打。畫面上只能綁在玩家按下去的按鈕，不能放進任何自動流程或重試。
   * `state` 是唯讀的，配對頁開著時輪詢它就好。
   */
  match: {
    state: () => ipcRenderer.invoke("ulr:match-state"),
    open: (options: Record<string, unknown>) => ipcRenderer.invoke("ulr:match-open", options),
    join: (roomId: string, pass: string) => ipcRenderer.invoke("ulr:match-join", roomId, pass),
    cancel: () => ipcRenderer.invoke("ulr:match-cancel"),
    /**
     * 自動配對（走中間人的佇列）。
     *
     * ⚠ `start` 會一路走到開房或進房 —— 跟 `open` 一樣是「替玩家操作遊戲」的
     * 東西，只能綁在玩家按下去的按鈕上。`stop` 會順手收掉開了一半的房。
     */
    queue: {
      start: (options: Record<string, unknown>) =>
        ipcRenderer.invoke("ulr:match-queue-start", options),
      stop: () => ipcRenderer.invoke("ulr:match-queue-stop"),
    },
  },

  /**
   * 隱藏地圖。
   *
   * ⚠ 跟 `match` 那一組**不一樣**：這裡沒有任何一支會替玩家操作遊戲。`set` 只是
   * 改遊戲自己那個下拉選單的內容，開房仍然是玩家在遊戲的對話框上按的。
   */
  stages: {
    state: () => ipcRenderer.invoke("ulr:stages-state"),
    set: (on: boolean) => ipcRenderer.invoke("ulr:stages-set", on),
    /** 重新推一次。給「等太久放棄了」那個狀態的按鈕。 */
    retry: () => ipcRenderer.invoke("ulr:stages-retry"),
  },

  /** 開機啟動那組全域選項。 */
  setOptions: (patch: Record<string, unknown>) => ipcRenderer.invoke("ulr:options", patch),

  /** 開外部連結。主程序那端有白名單。 */
  openExternal: (url: string) => ipcRenderer.invoke("ulr:open-external", url),

  /**
   * 把「要填進 Steam 啟動選項的那一行」放進剪貼簿。
   *
   * ⚠ **刻意不收參數。** 字串由主程序決定，畫面只能說「複製那一行」——
   * 見檔頭：介面越小，畫面被塞了一段別人的腳本時的後果越小。
   */
  copyDebugFlag: () => ipcRenderer.invoke("ulr:copy-debug-flag"),
});
