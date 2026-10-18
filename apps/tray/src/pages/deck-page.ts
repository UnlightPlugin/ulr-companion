/**
 * 托盤「牌組」那幾頁：牌組替換模式、人物篩選、等候套用、雲端同步（從 main.ts 拆出來，
 * 2026-10-18）。牌組庫本身在 deck-runtime.ts。
 */

import { isCharaPickerMode } from "@ulr/cdp-adapter";
import type { CharaPickerMode } from "@ulr/cdp-adapter";
import {
  pushCharaPicker,
  pushDeckState,
  resetDeckSession,
  runDeckSync,
  stopDeckCloudSync,
} from "../deck-runtime.js";
import { isDeckMode, normalizeApplyDelaySeconds } from "../profiles-core.js";
import type { DeckMode } from "../profiles-core.js";
import type { IpcHandle, TrayContext } from "../tray-context.js";

export function registerDeckPage(ipc: IpcHandle, ctx: TrayContext): void {
  /**
   * 改「等候套用」的秒數並記進配置。
   *
   * ⚠ 走 `patchProfile` 而不是 `editProfile`：臨時配置不在清單裡，`editProfile` 對它是
   * 空操作 —— 症狀是「改了秒數，下一次重畫又跳回去」。
   *
   * ⚠ **不必去通知頁面**。閘門那邊只認「有沒有東西沒寫」這個布林，秒數是托盤
   * 這一端在算的（`deckApplyTick`）。
   */
  ipc.handle("ulr:deck-apply-delay", (_event, raw: unknown): number => {
    const next = normalizeApplyDelaySeconds(raw);
    ctx.patchProfile({ applyDelaySeconds: next });
    ctx.pushState();
    return next;
  });

  /**
   * 牌組替換模式（插件／官方三牌組／關閉）。
   *
   * 切換時牌組庫**整份重新接上**（`resetDeckSession()`，下一拍 `initDeckLibrary()`）：
   * 兩種模式對伺服器三格的用法不一樣 —— 插件模式要把 Deck2／Deck3 收進庫裡清空，
   * 官方模式三格都是玩家的牌 —— 而接上那一步正是分流的地方。關閉就把選單拆掉、
   * 房間不再預載不再攔。
   */
  ipc.handle("ulr:deck-mode", async (_event, raw: unknown): Promise<DeckMode> => {
    if (!isDeckMode(raw) || raw === ctx.profile.deckMode) return ctx.profile.deckMode;
    ctx.patchProfile({ deckMode: raw });
    ctx.log(
      raw === "plugin"
        ? "· 牌組替換：插件模式（四房各存牌組、只用 Deck1；Deck2／Deck3 會收進庫裡清空）"
        : raw === "official"
          ? "· 牌組替換：官方三牌組（進房換上那一房的前三副）"
          : "· 牌組替換：關閉（插件不碰牌組）",
    );
    resetDeckSession();
    await pushDeckState();
    ctx.pushState();
    return ctx.profile.deckMode;
  });

  /**
   * 牌組編輯畫面 [Chara] 鈕的代表卡（`L1`..`L5`／`R`），`off` = 不畫那顆鈕。
   * 立刻生效：只是推新狀態，頁面下次打開角色一覽就用新的挑法。
   */
  ipc.handle("ulr:chara-picker", (_event, raw: unknown): CharaPickerMode => {
    if (!isCharaPickerMode(raw) || raw === ctx.profile.charaPicker) return ctx.profile.charaPicker;
    ctx.patchProfile({ charaPicker: raw });
    pushCharaPicker();
    ctx.pushState();
    return ctx.profile.charaPicker;
  });

  /** 雲端牌組同步開關。打開時馬上同步一輪。 */
  ipc.handle("ulr:deck-cloud-sync", (_event, on: unknown): boolean => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ deckCloudSync: on });
      if (on) {
        ctx.log("· 牌組跨電腦同步已開啟");
        void runDeckSync();
      } else {
        stopDeckCloudSync();
        ctx.log("· 牌組跨電腦同步已關閉（只用這台電腦的）");
      }
      ctx.pushState();
    }
    return ctx.profile.deckCloudSync;
  });
}
