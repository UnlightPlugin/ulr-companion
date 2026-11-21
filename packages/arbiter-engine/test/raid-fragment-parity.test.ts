/**
 * 碎片的例外怪有兩份：Discord 用的（arbiter-link）與渦房畫面用的（cdp-adapter，嵌進注入腳本）。
 * cdp-adapter 不依賴 arbiter-link，所以在兩邊都看得到的這裡對：改一邊忘了改另一邊就紅。
 */

import { describe, expect, it } from "vitest";
import {
  RAID_FEED_RANDOM_FRAGMENT_MONSTERS,
  RAID_FEED_STAGE_FROM_MAP,
} from "@ulr/arbiter-link/raid-feed";
import {
  RAID_RANDOM_FRAGMENT_MONSTERS,
  RAID_STAGE_FROM_MAP_MONSTERS,
  RAID_STAGE_START_MAP,
} from "@ulr/cdp-adapter";

describe("渦碎片的例外怪", () => {
  it("碎片隨機（不畫）的怪兩邊一樣", () => {
    expect([...RAID_RANDOM_FRAGMENT_MONSTERS].sort()).toEqual(
      [...RAID_FEED_RANDOM_FRAGMENT_MONSTERS].sort(),
    );
  });

  it("stage 是假的、照區塊推的怪兩邊一樣（起點也一樣）", () => {
    const page = Object.fromEntries(
      RAID_STAGE_FROM_MAP_MONSTERS.map((m) => [m, RAID_STAGE_START_MAP[m]]),
    );
    expect(page).toEqual(RAID_FEED_STAGE_FROM_MAP);
  });
});
