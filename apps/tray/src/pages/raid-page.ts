/**
 * 托盤「渦」那幾頁：獎勵標記、結算通知、物品捷徑、發現渦（從 main.ts 拆出來，2026-10-18）。
 */

import {
  isRaidRewardMode,
  normalizeRaidDiscoverRules,
  RAID_DISCOVER_ACTIONS,
  RAID_DISCOVER_BOSSES,
  RAID_FRAGMENTS,
} from "@ulr/cdp-adapter";
import type {
  ItemPanelStatus,
  RaidDiscoverAction,
  RaidDiscoverBoss,
  RaidDiscoverSetting,
  RaidRewardMode,
  RaidRewardStatus,
  RaidViewStatus,
} from "@ulr/cdp-adapter";
import type { Profile } from "../profiles-core.js";
import type { IpcHandle, TrayContext } from "../tray-context.js";

/** 渦那一頁要畫的東西：兩支注入腳本的狀態＋結算面板的模式。 */
export interface RaidPageState {
  rewardMode: RaidRewardMode;
  share: boolean;
  teamShare: boolean;
  autoDelete: boolean;
  autoDeletePrompt: boolean;
  itemShortcut: boolean;
  historyButton: boolean;
  discoverSkipOpening: boolean;
  discoverRules: Record<string, RaidDiscoverAction>;
  discoverRulesOn: boolean;
  /** 規則表的列（BOSS）與欄（碎片）：畫面照這份畫，不自己抄一份 */
  discoverBosses: readonly RaidDiscoverBoss[];
  discoverFragments: { key: string; short: string; css: string }[];
  view: RaidViewStatus | null;
  reward: RaidRewardStatus | null;
  items: ItemPanelStatus | null;
}

export async function raidPageState(ctx: TrayContext): Promise<RaidPageState> {
  const { profile, engine } = ctx;
  return {
    rewardMode: profile.raidRewardMode,
    share: profile.raidShare,
    teamShare: profile.raidTeamShare,
    autoDelete: profile.raidAutoDelete,
    autoDeletePrompt: profile.raidAutoDeletePrompt,
    itemShortcut: profile.raidItemShortcut,
    historyButton: profile.raidHistoryButton,
    discoverSkipOpening: profile.raidDiscoverSkipOpening,
    discoverRules: profile.raidDiscoverRules,
    discoverRulesOn: profile.raidDiscoverRulesOn,
    discoverBosses: RAID_DISCOVER_BOSSES,
    discoverFragments: RAID_FRAGMENTS.map((f) => ({ key: f.key, short: f.short, css: f.css })),
    view: (await engine?.raidViewStatus().catch(() => null)) ?? null,
    reward: (await engine?.raidRewardStatus().catch(() => null)) ?? null,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
  };
}

/** 推給頁面的發現渦設定：規則表關著就推空的（規則留在配置裡，打開就回來）。 */
export function raidDiscoverSetting(p: Profile): RaidDiscoverSetting {
  return {
    skipOpening: p.raidDiscoverSkipOpening,
    rules: p.raidDiscoverRulesOn ? p.raidDiscoverRules : {},
  };
}

export function describeRaidRewardMode(mode: RaidRewardMode): string {
  return mode === "all" ? "全部通知" : mode === "none" ? "不再通知" : "只通知一次";
}

export function registerRaidPage(ipc: IpcHandle, ctx: TrayContext): void {
  const state = (): Promise<RaidPageState> => raidPageState(ctx);

  ipc.handle("ulr:raid-state", async (): Promise<RaidPageState> => state());

  ipc.handle("ulr:raid-reward-mode", async (_event, raw: unknown): Promise<RaidPageState> => {
    if (isRaidRewardMode(raw)) {
      ctx.patchProfile({ raidRewardMode: raw });
      ctx.engine?.setRaidRewardMode(raw);
      ctx.log(`· 渦結算通知改為「${describeRaidRewardMode(raw)}」`);
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:raid-share", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ raidShare: on });
      ctx.engine?.setRaidShare(on);
      ctx.log(on ? "· 插件互傳渦狀態已開啟" : "· 插件互傳渦狀態已關閉（只用 ulgg）");
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:raid-team-share", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ raidTeamShare: on });
      ctx.engine?.setRaidTeamShare(on);
      ctx.log(
        on
          ? "· 分享打渦隊伍已開啟"
          : "· 分享打渦隊伍已關閉（下一輪會把 Cloudflare Workers 上自己的隊伍撤掉）",
      );
      ctx.pushState();
    }
    return state();
  });

  /** 插件視窗這邊打開自動刪除時，遊戲內的提示鈕也一起恢復。 */
  ipc.handle("ulr:raid-auto-delete", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      const prompt = on ? true : ctx.profile.raidAutoDeletePrompt;
      ctx.patchProfile({ raidAutoDelete: on, raidAutoDeletePrompt: prompt });
      ctx.engine?.setRaidAutoDelete({ enabled: on, prompt });
      ctx.log(on ? "· 自動刪除死渦已開啟" : "· 自動刪除死渦已停用");
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:raid-item-shortcut", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ raidItemShortcut: on });
      ctx.engine?.setItemShortcut(on);
      ctx.log(on ? "· 渦房物品捷徑已開啟" : "· 渦房物品捷徑已關閉（好友與物品鈕放回來）");
      ctx.pushState();
    }
    return state();
  });

  ipc.handle("ulr:raid-history-button", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      ctx.patchProfile({ raidHistoryButton: on });
      ctx.engine?.setRaidHistoryButton(on);
      ctx.log(on ? "· 渦房 History 鈕已顯示" : "· 渦房 History 鈕已隱藏（渦獎勵照樣記錄）");
      ctx.pushState();
    }
    return state();
  });

  /** 發現渦之後：跳過開場（一個開關）＋「BOSS × 碎片」規則（公開／僅限好友／刪除／不動）。 */
  const applyRaidDiscover = (patch: Partial<Profile>): void => {
    ctx.patchProfile(patch);
    ctx.engine?.setRaidDiscover(raidDiscoverSetting(ctx.profile));
    ctx.pushState();
  };

  ipc.handle("ulr:raid-discover-skip", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      applyRaidDiscover({ raidDiscoverSkipOpening: on });
      ctx.log(on ? "· 發現渦：跳過開場動畫" : "· 發現渦：開場動畫照播");
    }
    return state();
  });

  /** 規則表整個開關：關掉時規則留著、不推下去。 */
  ipc.handle("ulr:raid-discover-rules-on", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      applyRaidDiscover({ raidDiscoverRulesOn: on });
      ctx.log(
        on ? "· 發現渦：照規則表做（公開／好友／渦碼／刪除）" : "· 發現渦：規則表暫停（規則留著）",
      );
    }
    return state();
  });

  /** 一次改一格或一整組（keys），同一個動作。 */
  ipc.handle(
    "ulr:raid-discover-rule",
    async (_event, keys: unknown, action: unknown): Promise<RaidPageState> => {
      if (
        Array.isArray(keys) &&
        keys.every((k) => typeof k === "string") &&
        RAID_DISCOVER_ACTIONS.includes(action as RaidDiscoverAction)
      ) {
        const next: Record<string, unknown> = { ...ctx.profile.raidDiscoverRules };
        for (const k of keys as string[]) {
          if (action === "keep") delete next[k];
          else next[k] = action;
        }
        // 認不得的鍵在這裡丟掉
        applyRaidDiscover({ raidDiscoverRules: normalizeRaidDiscoverRules(next) });
      }
      return state();
    },
  );
}
