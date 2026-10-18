/**
 * 托盤「自訂COST」那幾頁：選規則檔、模式、遊戲裡套不套、編輯 COST／規則
 * （從 main.ts 拆出來，2026-10-18）。規則本身的載入與狀態在 cost-rule-runtime.ts。
 */

import { catalogSize } from "@ulr/rule-schema";
import { writeCatalog } from "../catalog-store.js";
import {
  changeCostRule,
  costRule,
  costRuleFull,
  editorPayload,
  gameVersionNow,
  loadCostRule,
  pushCostRuleToEngine,
  saveEditedRule,
  setCatalog,
} from "../cost-rule-runtime.js";
import type { EditorPayload, EditorSaveResult } from "../cost-rule-runtime.js";
import type { EngineStatus } from "@ulr/arbiter-engine";
import { normalizeEditStep, normalizeEditUnit } from "../profiles-core.js";
import type { CostRuleMode, Profile } from "../profiles-core.js";
import type { IpcHandle, TrayContext } from "../tray-context.js";

/** 這幾頁另外要的東西（main.ts 給）。 */
export interface CostPageDeps {
  /** 開檔案選擇框選一份規則檔；取消回 undefined。對話框開在主程序（見 main.ts）。 */
  pickCostFile(): Promise<string | undefined>;
  /** 改指定 id 的配置並寫回設定檔（main.ts 的 editProfile）。 */
  editProfile(id: string, patch: Partial<Omit<Profile, "id">>): void;
  /** 整份快照（這幾頁改完回傳給畫面的就是它）。 */
  snapshot(): unknown;
  /** 引擎最後一次回報的狀態；沒接著遊戲是 null。 */
  latest(): EngineStatus | null;
}

export function registerCostPage(ipc: IpcHandle, ctx: TrayContext, deps: CostPageDeps): void {
  /**
   * 選一份 COST 規則檔。
   *
   * ⚠ 檔案選擇框開在**主程序**，渲染層永遠碰不到路徑字串以外的東西 ——
   * `preload.ts` 的介面刻意小，這裡不能為了方便就把 fs 攤出去。
   */
  ipc.handle("ulr:cost-pick", async () => {
    const picked = await deps.pickCostFile();
    if (picked === undefined) return deps.snapshot();

    // ⚠ 選了檔就等於離開預設模式。少了 `costRuleMode` 這一格的話，下次開機
    // 會被預設規則蓋回去 —— 而畫面上寫著他選的那個檔名。
    deps.editProfile(ctx.profile.id, { costRulePath: picked, costRuleMode: "file" });
    changeCostRule();
    ctx.pushState();
    return deps.snapshot();
  });

  /**
   * 換 COST 規則的來源（預設／自己的檔／停用）。
   *
   * ⚠ 切回 `file` 時**沿用上次選過的路徑**，沒選過就什麼都不載 —— 畫面那邊
   * 會顯示「還沒選檔」並附上選檔按鈕。這比「切過去就跳檔案選擇框」好：
   * 玩家可能只是想看看有哪些選項。
   */
  ipc.handle("ulr:cost-mode", (_event, raw: unknown) => {
    const mode: CostRuleMode = raw === "file" || raw === "off" ? raw : "default";
    deps.editProfile(ctx.profile.id, { costRuleMode: mode });
    changeCostRule();
    if (mode === "off") ctx.log("· 自訂 COST 已停用（遊戲畫面當場換回原版數字）");
    ctx.pushState();
    return deps.snapshot();
  });

  /** 取消套用，回到原版數字。 */
  ipc.handle("ulr:cost-clear", () => {
    deps.editProfile(ctx.profile.id, { costRuleMode: "off" });
    changeCostRule();
    ctx.log("· 自訂 COST 已停用（遊戲畫面當場換回原版數字）");
    ctx.pushState();
    return deps.snapshot();
  });

  /**
   * 遊戲畫面上套不套自訂 COST（見 `Profile.customCostInGame`）。規則不動。
   *
   * ⚠ **不重載**（玩家 2026-10-11：「官方和自訂 COST 切換都不用重載」）。兩個方向
   * 都由引擎當場改快取：打開走 `installCostOverridesLive`，關掉走
   * `revertCostOverrides`（把頁面上留著的自訂價與自訂表收掉）。
   *
   * ⚠ 走 `patchProfile` 而不是 `editProfile`：臨時配置不在清單裡，
   * `editProfile` 對它是空操作。
   */
  ipc.handle("ulr:cost-in-game", (_event, on: unknown) => {
    if (typeof on === "boolean" && on !== ctx.profile.customCostInGame) {
      ctx.patchProfile({ customCostInGame: on });
      pushCostRuleToEngine();
      ctx.log(
        on
          ? "· 遊戲裡套用自訂 COST（迪特赫姆、牌組編輯）"
          : "· 遊戲裡不套用自訂 COST（迪特赫姆、牌組編輯都是官方價）",
      );
      ctx.pushState();
    }
    return deps.snapshot();
  });

  // -------------------------------------------------------------------------
  // 編輯 COST
  // -------------------------------------------------------------------------

  ipc.handle("ulr:editor-load", (): EditorPayload => editorPayload());

  /**
   * 改上下鍵的幅度並**記進配置**。不碰遊戲、不碰規則檔，只是偏好。
   *
   * ⚠ 走 `patchProfile` 而不是 `editProfile`：臨時配置（`--port` 對不上任何
   * 一份時建的）不在清單裡，`editProfile` 對它是完全的空操作 —— 症狀是「改了
   * 幅度，下一次重畫又跳回去」。跟 `ulr:set-tint`、`ulr:match-prefs` 同一招。
   */
  ipc.handle("ulr:editor-step", (_event, raw: unknown): number => {
    const next = normalizeEditStep(raw);
    ctx.patchProfile({ editStep: next });
    return next;
  });

  /**
   * 改「最小單位」檢查的值並記進配置。**0 = 不檢查。**
   *
   * ⚠ 這**不會動到規則檔**。最小單位不是規則的欄位，是編輯器的工具設定 ——
   * 作者要讓拿到規則的人知道，得自己寫進「編輯描述」的說明欄（那一欄現在在
   * 「Cost 表」那一頁讀得到）。完整理由見 `profiles-core.ts` 的
   * `normalizeEditUnit`。
   */
  ipc.handle("ulr:editor-unit", (_event, raw: unknown): number => {
    const next = normalizeEditUnit(raw);
    ctx.patchProfile({ editUnit: next });
    return next;
  });

  /**
   * 從跑著的遊戲重讀名冊。
   *
   * ⚠ **套用中的客戶端讀不得。** `patch-cost` 是就地改寫 Phaser 快取，套過之後
   * 讀回來的「原價」會是上一份規則的數字 —— 而編輯器的「改回原價」與價差色階
   * 正是拿它當基準，於是玩家按下去會改回一個他從來沒設過的值。
   *
   * ⚠ 下面這道閘**只是快路**（省一趟 CDP 往返，訊息也講得清楚一點）。它問的是
   * 插件記著的狀態，而那擋不住「停用了但沒重載」「剛換一份規則」「托盤重開過」
   * 這三種頁面仍然是髒的情況 —— 真正的判斷在 `readCardCatalog` 裡問頁面自己。
   * **不要**因為這裡有檢查就把那邊的拿掉。
   */
  ipc.handle("ulr:editor-catalog", async (): Promise<EditorPayload> => {
    const engine = ctx.engine;
    if (engine === null) return { ...editorPayload(), catalogError: "還沒接上遊戲。" };
    if (deps.latest()?.cost.phase === "applied") {
      return {
        ...editorPayload(),
        catalogError:
          "目前的客戶端正套著自訂 COST，讀回來的「原價」會是改過的數字。" +
          "請先在「Cost 表」按停用、重載遊戲，再回來讀一次。",
      };
    }
    try {
      const fresh = await engine.readCardCatalog(costRule?.gameVersion ?? gameVersionNow());
      writeCatalog(fresh);
      setCatalog(fresh);
      const n = catalogSize(fresh);
      ctx.log(
        `✓ 已讀取卡片名冊：角色 ${n.characters}、怪物 ${n.monsters}、` +
          `裝備 ${n.equipment}、事件卡 ${n.eventCards}`,
      );
      return editorPayload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`✗ 讀取卡片名冊失敗：${message}`);
      return { ...editorPayload(), catalogError: message };
    }
  });

  /**
   * 把編輯好的東西寫回**目前選著的那個檔**。
   *
   * 兩頁共用這一支：編輯 COST 送 `tables`、編輯規則送 `compression`。
   * ⚠ **沒送到的部分會沿用檔案裡原本那份**（見 `saveEditedRule`）——
   * 一頁存檔不該把另一頁的東西洗掉。
   *
   * ⚠ 就地覆寫、**不改檔名**。之前 `unpack` 的產物留在同一個資料夾裡，造成
   * 「同一份規則有兩個檔」的困惑；每存一次就多一個檔會把同樣的問題放大。
   * 版本號要不要動由作者自己決定（`version` 欄位），核對碼一律重算。
   */
  ipc.handle("ulr:editor-save", (_e, payload: unknown): EditorSaveResult => {
    if (costRule === null || costRuleFull === null) {
      return { ok: false, error: "還沒選規則檔。請先到「Cost 表」選一份。" };
    }
    try {
      const saved = saveEditedRule(costRuleFull, costRule.path, payload);
      // 存完立刻重新載入 —— 不重載的話畫面顯示的核對碼還是舊的，而那正是
      // 玩家要拿去跟對手核對的東西。
      loadCostRule(costRule.path);
      ctx.pushState();
      return { ok: true, shortHash: saved.short, version: saved.version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`✗ 儲存 COST 表失敗：${message}`);
      return { ok: false, error: message };
    }
  });
}
