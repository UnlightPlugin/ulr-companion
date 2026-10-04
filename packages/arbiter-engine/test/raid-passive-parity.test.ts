/**
 * 渦 BOSS 被動的規則有兩份：Discord 用的（arbiter-link）與渦房畫面用的（cdp-adapter，嵌進注入腳本）。
 * cdp-adapter 不依賴 arbiter-link，所以在兩邊都看得到的這裡對：改一邊忘了改另一邊就紅。
 */

import { describe, expect, it } from "vitest";
import { RAID_PASSIVE_RULES as LINK_RULES } from "@ulr/arbiter-link/raid-passive";
import { RAID_PASSIVE_RULES as PAGE_RULES } from "@ulr/cdp-adapter";

describe("渦 BOSS 被動規則", () => {
  it("Discord 與渦房畫面是同一張表", () => {
    expect(PAGE_RULES).toEqual(LINK_RULES);
  });
});
