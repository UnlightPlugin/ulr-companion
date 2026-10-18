/**
 * 托盤「任務」那幾頁：物品捷徑、寶箱標註、確認框（從 main.ts 拆出來，2026-10-18）。
 */

import { isQuestPanelMode, summarizeQuestBonus } from "@ulr/cdp-adapter";
import type {
  ItemPanelStatus,
  QuestBonusStats,
  QuestPanelMode,
  QuestTreasureStatus,
} from "@ulr/cdp-adapter";
import { readQuestBonus } from "../quest-bonus-store.js";
import type { IpcHandle, TrayContext } from "../tray-context.js";

/** 任務那幾頁要畫的東西：物品捷徑、寶箱標註、確認框的設定＋兩支注入腳本的狀態。 */
export interface QuestPageState {
  stackShortcut: boolean;
  passShortcut: boolean;
  treasureMarks: boolean;
  rewardPanel: QuestPanelMode;
  endPanel: QuestPanelMode;
  skipResult: boolean;
  items: ItemPanelStatus | null;
  treasure: QuestTreasureStatus | null;
  /** 學到的 HighLow 開始星數：每一級的最小／最大 step、幾筆。 */
  bonus: QuestBonusStats;
}

export async function questPageState(ctx: TrayContext): Promise<QuestPageState> {
  const { profile, engine } = ctx;
  return {
    stackShortcut: profile.questStackShortcut,
    passShortcut: profile.questPassShortcut,
    treasureMarks: profile.questTreasureMarks,
    rewardPanel: profile.questRewardPanel,
    endPanel: profile.questEndPanel,
    skipResult: profile.questSkipResult,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
    treasure: (await engine?.questTreasureStatus().catch(() => null)) ?? null,
    bonus: summarizeQuestBonus(engine?.questBonusSamples ?? readQuestBonus()),
  };
}

export function registerQuestPage(ipc: IpcHandle, ctx: TrayContext): void {
  const state = (): Promise<QuestPageState> => questPageState(ctx);

  ipc.handle("ulr:quest-state", (): Promise<QuestPageState> => state());

  ipc.handle(
    "ulr:quest-item-shortcut",
    // `part`：`stack` 水沙捷徑、`passes` 通行證捷徑，各自開關。
    async (_event, part: unknown, on: unknown): Promise<QuestPageState> => {
      if ((part === "stack" || part === "passes") && typeof on === "boolean") {
        const key = part === "stack" ? "questStackShortcut" : "questPassShortcut";
        ctx.patchProfile({ [key]: on });
        ctx.engine?.setQuestItemShortcut(part, on);
        const name = part === "stack" ? "水沙捷徑" : "通行證捷徑";
        ctx.log(on ? `· 任務房${name}已開啟` : `· 任務房${name}已關閉`);
        ctx.pushState();
      }
      return state();
    },
  );

  ipc.handle("ulr:quest-treasure", async (_event, on: unknown): Promise<QuestPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ questTreasureMarks: on });
      ctx.engine?.setQuestTreasure(on);
      ctx.log(on ? "· 任務地圖寶箱標註已開啟" : "· 任務地圖寶箱標註已關閉");
      ctx.pushState();
    }
    return state();
  });

  ipc.handle(
    "ulr:quest-panel",
    async (_event, part: unknown, mode: unknown): Promise<QuestPageState> => {
      if ((part === "reward" || part === "end") && isQuestPanelMode(mode)) {
        const patch = part === "reward" ? { questRewardPanel: mode } : { questEndPanel: mode };
        ctx.patchProfile(patch);
        ctx.engine?.setQuestPanel(part, mode);
        const what = part === "reward" ? "寶箱面板" : "任務結束確認框";
        const how = mode === "auto" ? "自動按 OK" : mode === "hide" ? "不顯示" : "照官方";
        ctx.log(`· 任務${what}：${how}`);
        ctx.pushState();
      }
      return state();
    },
  );

  ipc.handle("ulr:quest-skip-result", async (_event, on: unknown): Promise<QuestPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ questSkipResult: on });
      ctx.engine?.setQuestSkipResult(on);
      ctx.log(on ? "· 任務打完怪物：跳過結算" : "· 任務打完怪物：照官方看結算");
      ctx.pushState();
    }
    return state();
  });
}
