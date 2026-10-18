/**
 * 托盤「獎勵」那幾頁：物品捷徑、High Low、快轉、自動爬星（從 main.ts 拆出來，2026-10-18）。
 */

import { isBonusItemOrder, isBonusItemPlace, normalizeBonusClimb } from "@ulr/cdp-adapter";
import type {
  BonusClimbConfig,
  BonusItemOrder,
  BonusItemPlace,
  ItemPanelStatus,
} from "@ulr/cdp-adapter";
import type { IpcHandle, TrayContext } from "../tray-context.js";

/** 獎勵 › 物品捷徑要畫的東西：開關、畫在哪、差距大時先用哪一種＋物品欄那支的狀態。 */
export interface BonusPageState {
  itemShortcut: boolean;
  place: BonusItemPlace;
  order: BonusItemOrder;
  /** High／Low 跟下一個卡片、得到卡片一起顯示。 */
  highLow: boolean;
  /** 跳過擲骰動畫。 */
  fast: boolean;
  /** 用道具救起來之後快轉。 */
  rescueFast: boolean;
  /** 結束後不看第二次結算。 */
  skipEnd: boolean;
  /** 自動爬星：開關＋勝場、敗場兩組目標。 */
  climb: BonusClimbConfig;
  items: ItemPanelStatus | null;
}

export async function bonusPageState(ctx: TrayContext): Promise<BonusPageState> {
  const { profile, engine } = ctx;
  return {
    itemShortcut: profile.bonusItemShortcut,
    place: profile.bonusItemPlace,
    order: profile.bonusItemOrder,
    highLow: profile.bonusHighLow,
    fast: profile.bonusFast,
    rescueFast: profile.bonusRescueFast,
    skipEnd: profile.bonusSkipEnd,
    climb: profile.bonusClimb,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
  };
}

export function registerBonusPage(ipc: IpcHandle, ctx: TrayContext): void {
  const state = (): Promise<BonusPageState> => bonusPageState(ctx);

  ipc.handle("ulr:bonus-state", (): Promise<BonusPageState> => state());

  // 三選一：無捷徑（off）、按鈕左上（above）、蓋在使用物品上（cover）。關的時候位置不動，
  // 下次打開還是上次選的地方
  ipc.handle("ulr:bonus-mode", async (_event, mode: unknown): Promise<BonusPageState> => {
    if (mode === "off" || isBonusItemPlace(mode)) {
      const on = mode !== "off";
      const place = mode === "off" ? ctx.profile.bonusItemPlace : mode;
      ctx.patchProfile({ bonusItemShortcut: on, bonusItemPlace: place });
      ctx.engine?.setBonusItemPlace(place);
      ctx.engine?.setBonusItemShortcut(on);
      ctx.log(
        mode === "off"
          ? "· 獎勵遊戲物品捷徑已關閉"
          : mode === "cover"
            ? "· 獎勵遊戲物品捷徑：蓋在使用物品上"
            : "· 獎勵遊戲物品捷徑：畫在按鈕左上",
      );
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:bonus-order", async (_event, order: unknown): Promise<BonusPageState> => {
    if (isBonusItemOrder(order)) {
      ctx.patchProfile({ bonusItemOrder: order });
      ctx.engine?.setBonusItemOrder(order);
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:bonus-highlow", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ bonusHighLow: on });
      ctx.engine?.setBonusHighLow(on);
      ctx.log(on ? "· 獎勵遊戲 High Low：跟下一個卡片一起顯示" : "· 獎勵遊戲 High Low：照官方");
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:bonus-fast", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ bonusFast: on });
      ctx.engine?.setBonusFast(on);
      ctx.log(on ? "· 獎勵遊戲：跳過擲骰動畫" : "· 獎勵遊戲：擲骰動畫照官方");
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:bonus-rescue-fast", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ bonusRescueFast: on });
      ctx.engine?.setBonusRescueFast(on);
      ctx.log(on ? "· 獎勵遊戲：用道具救起來之後快轉" : "· 獎勵遊戲：用道具之後照官方");
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:bonus-skip-end", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ bonusSkipEnd: on });
      ctx.engine?.setBonusSkipEnd(on);
      ctx.log(on ? "· 獎勵遊戲：結束後直接回房間" : "· 獎勵遊戲：結束後照官方看結算");
      ctx.pushState();
    }
    return state();
  });

  // 整份設定一起來（開關＋兩組目標）；不合理的數字在 normalizeBonusClimb 裡夾回範圍
  ipc.handle("ulr:bonus-climb", async (_event, config: unknown): Promise<BonusPageState> => {
    const next = normalizeBonusClimb(config);
    const toggled = next.on !== ctx.profile.bonusClimb.on;
    ctx.patchProfile({ bonusClimb: next });
    ctx.engine?.setBonusClimb(next);
    if (toggled) ctx.log(next.on ? "· 獎勵遊戲：自動爬星開啟" : "· 獎勵遊戲：自動爬星已關閉");
    ctx.pushState();
    return state();
  });
}
