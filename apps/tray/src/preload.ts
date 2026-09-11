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
    /**
     * 換規則來源：`default`（插件附的、會自己更新）／`file`（自己選的檔）／
     * `off`（原版數字）。
     *
     * ⚠ 收的是一個**列舉值**而不是路徑 —— 同上，渲染層不指定檔案。
     */
    mode: (mode: "default" | "file" | "off") => ipcRenderer.invoke("ulr:cost-mode", mode),
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
    /** 目前規則的四張表 + 壓 C + 描述欄位 + 卡片名冊。開編輯頁時叫一次。 */
    load: () => ipcRenderer.invoke("ulr:editor-load"),
    /**
     * 存回目前的規則檔。三頁共用這一支：`tables`（編輯 COST）、
     * `compression`（編輯規則）、`meta`（編輯描述）。
     *
     * ⚠ **沒送到的部分會沿用檔案裡原本那份** —— 一頁存檔不該把另一頁的東西
     * 洗掉。少送 `tables` 不是「清空四張表」。
     */
    save: (payload: Record<string, unknown>) => ipcRenderer.invoke("ulr:editor-save", payload),
    /** 從跑著的遊戲重讀一份名冊（中文名 + 原價）。 */
    refreshCatalog: () => ipcRenderer.invoke("ulr:editor-catalog"),
    /**
     * 改上下鍵的幅度並記進配置。回傳主程序夾過的那個值。
     *
     * 不碰遊戲也不碰規則檔，所以畫面可以在玩家一改就叫，不必等按什麼按鈕。
     */
    step: (value: number) => ipcRenderer.invoke("ulr:editor-step", value),
    /**
     * 改「最小單位」檢查的值並記進配置。**0 = 不檢查。**
     *
     * ⚠ 跟 `step` 一樣**不碰規則檔** —— 最小單位不是規則的欄位，是編輯器的
     * 工具設定。作者要宣告它得自己寫進描述欄。
     */
    unit: (value: number) => ipcRenderer.invoke("ulr:editor-unit", value),
  },

  /**
   * 對戰地點。**只剩一支，而且它不碰遊戲。**
   *
   * ⚠ `state` 與 `queue.start`／`queue.stop` 拿掉了（WP-18）：排隊的入口是
   * **遊戲大廳裡那顆「快速比賽」**，而那條路從頭到尾都在主程序裡。畫面這邊
   * 連一支「會替玩家操作遊戲」的方法都不再需要 —— 這正是這個檔頭那句話的
   * 意思：介面越小，「畫面被塞了一段別人的腳本」的後果越小。
   *
   * ⚠ **房名不在這條介面上，檔位也不在。** 房名是主程序照「規則名 + 檔位」
   * 組的（`buildRoomName`），檔位是照牌組算的（`myDeckTier`）。畫面能指定
   * 它們的話，那些值會被送進遊戲封包或配對鍵，而漂掉一個字的症狀是
   * 「開好房卻找不到自己那間」／「明明條件一樣卻永遠配不到」。
   */
  match: {
    /** 改「這一場開在哪」並記進配置。回主程序整理過的那一份。 */
    prefs: (patch: Record<string, unknown>) => ipcRenderer.invoke("ulr:match-prefs", patch),
  },

  /**
   * 隱藏地圖。
   *
   * ⚠ 跟 `match` 那一組**不一樣**：這裡沒有任何一支會替玩家操作遊戲。`set` 只是
   * 改遊戲自己那個下拉選單的內容，開房仍然是玩家在遊戲的對話框上按的。
   */
  /**
   * 牌組的「等候套用」秒數。
   *
   * ⚠ 只是一個偏好 —— 這支不碰遊戲、不碰牌組。切了牌組之後等幾秒才寫進
   * 伺服器由它決定，開戰時會無視它（攔下來立刻寫完再放行）。
   */
  deck: {
    applyDelay: (seconds: number) => ipcRenderer.invoke("ulr:deck-apply-delay", seconds),
  },

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
