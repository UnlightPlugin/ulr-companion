/**
 * 托盤「迪特赫姆」的物品捷徑、GEM UP、投降那幾頁（從 main.ts 拆出來，2026-10-18）。
 * 隱藏地圖那一頁跟開房設定綁在一起，還留在 main.ts。
 */

import type {
  BattleSurrenderOptions,
  ItemPanelStatus,
  RaidSurrenderStatus,
} from "@ulr/cdp-adapter";
import type { Profile } from "../profiles-core.js";
import type { IpcHandle, TrayContext } from "../tray-context.js";

/**
 * 迪特赫姆那幾頁（物品捷徑、GEM UP、投降）要畫的東西：開關＋物品欄那支的狀態＋
 * 投降那支（渦戰投降鈕的注入腳本，對戰 MENU 歸它管）的狀態。
 */
export interface DietPageState {
  itemShortcut: boolean;
  gemUp: boolean;
  surrenderNoConfirm: boolean;
  surrenderOutside: boolean;
  surrenderWinSkip: boolean;
  items: ItemPanelStatus | null;
  surrender: RaidSurrenderStatus | null;
}

export function battleSurrenderOptions(profile: Profile): BattleSurrenderOptions {
  return {
    dietNoConfirm: profile.dietSurrenderNoConfirm,
    outside: profile.surrenderOutside,
    dietWinSkip: profile.dietSurrenderWinSkip,
  };
}

export async function dietPageState(ctx: TrayContext): Promise<DietPageState> {
  const { profile, engine } = ctx;
  return {
    itemShortcut: profile.dietItemShortcut,
    gemUp: profile.dietGemUp,
    surrenderNoConfirm: profile.dietSurrenderNoConfirm,
    surrenderOutside: profile.surrenderOutside,
    surrenderWinSkip: profile.dietSurrenderWinSkip,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
    surrender: (await engine?.raidSurrenderStatus().catch(() => null)) ?? null,
  };
}

export function registerDietPage(ipc: IpcHandle, ctx: TrayContext): void {
  const state = (): Promise<DietPageState> => dietPageState(ctx);

  ipc.handle("ulr:diet-state", (): Promise<DietPageState> => state());

  ipc.handle(
    "ulr:diet-toggle",
    // `part`：`dietStack` 水捷徑、`gemUp` GEM UP，各自開關。
    async (_event, part: unknown, on: unknown): Promise<DietPageState> => {
      if ((part === "dietStack" || part === "gemUp") && typeof on === "boolean") {
        const key = part === "dietStack" ? "dietItemShortcut" : "dietGemUp";
        ctx.patchProfile({ [key]: on });
        ctx.engine?.setDietOverlay(part, on);
        const name = part === "dietStack" ? "物品捷徑" : "GEM UP";
        ctx.log(on ? `· 迪城${name}已開啟` : `· 迪城${name}已關閉`);
        ctx.pushState();
      }
      return state();
    },
  );

  ipc.handle(
    "ulr:surrender-option",
    // `part`：`noConfirm` 迪城投降不確認、`outside` 投降鈕放 MENU 外面（渦、亞城也算）、
    // `winSkip` 迪城對手投降時直接到獎勵遊戲。
    async (_event, part: unknown, on: unknown): Promise<DietPageState> => {
      if (
        (part === "noConfirm" || part === "outside" || part === "winSkip") &&
        typeof on === "boolean"
      ) {
        const key =
          part === "noConfirm"
            ? "dietSurrenderNoConfirm"
            : part === "winSkip"
              ? "dietSurrenderWinSkip"
              : "surrenderOutside";
        ctx.patchProfile({ [key]: on });
        ctx.engine?.setBattleSurrender(battleSurrenderOptions(ctx.profile));
        if (part === "noConfirm") ctx.log(on ? "· 迪城投降改成直接投降" : "· 迪城投降照官方跳確認");
        else if (part === "winSkip")
          ctx.log(on ? "· 迪城對手投降時直接到獎勵遊戲" : "· 迪城對手投降照官方跳通知框");
        else ctx.log(on ? "· 投降鈕放到 MENU 外面" : "· 投降鈕收回 MENU 裡");
        ctx.pushState();
      }
      return state();
    },
  );
}
