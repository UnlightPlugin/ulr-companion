import { describe, expect, it } from "vitest";
import { DEFAULT_LINK_TARGET } from "@ulr/arbiter-link";
import type { Profile, ProfileStore } from "../src/profiles-core.js";
import {
  addTo,
  clampPort,
  defaultPortFor,
  defaultProfile,
  emptyStore,
  DEFAULT_EDIT_STEP,
  DEFAULT_MATCH_PREFS,
  EDIT_UNITS,
  normalizeEditStep,
  normalizeEditUnit,
  normalizeMatchPrefs,
  normalizeProfile,
  normalizeStore,
  removeFrom,
  resolveProfile,
  updateIn,
  userDataDirFor,
} from "../src/profiles-core.js";

function storeOf(...ports: number[]): ProfileStore {
  return {
    ...emptyStore(),
    profiles: ports.map((port, i) => ({
      ...defaultProfile("desktop"),
      id: `id${i}`,
      name: `配置${i}`,
      port,
    })),
  };
}

describe("整理清單", () => {
  it("壞掉的輸入一律回一份能用的預設，不拋例外", () => {
    // 托盤沒有視窗可以顯示錯誤 —— 這裡拋例外的代價是「程式打不開，而且不知道為什麼」。
    for (const bad of [null, undefined, 42, "x", [], {}, { profiles: "nope" }]) {
      expect(normalizeStore(bad).profiles.length).toBeGreaterThan(0);
    }
  });

  it("⚠ 空清單要被補成一份 —— 沒有配置的話視窗沒有東西可綁", () => {
    expect(normalizeStore({ profiles: [] }).profiles).toHaveLength(1);
  });

  it("缺欄位的配置用預設值補起來", () => {
    const s = normalizeStore({ profiles: [{ id: "a" }] });
    expect(s.profiles[0]?.port).toBe(defaultPortFor("desktop"));
    expect(s.profiles[0]?.name).toBe("桌面版");
    expect(s.profiles[0]?.prefs.speedFactor).toBe(1);
  });

  it("⚠ 中間人預設是雲端，而且舊設定檔的 linkPort 要被丟掉", () => {
    // 搬過來的話每個既有使用者都會停在一個永遠配不到對手的本機中間人上，
    // 而畫面上完全看不出來 —— 狀態列寫「還沒配到對手」，那句話在對手真的
    // 沒裝插件時也是同一句。
    expect(defaultProfile("desktop").link).toBe(DEFAULT_LINK_TARGET);
    const migrated = normalizeStore({ profiles: [{ id: "a", linkPort: 9350 }] });
    expect(migrated.profiles[0]?.link).toBe(DEFAULT_LINK_TARGET);
    // 明確填的值照留（開發者的 local 逃生口）。
    expect(normalizeStore({ profiles: [{ id: "a", link: "local" }] }).profiles[0]?.link).toBe(
      "local",
    );
  });

  it("lastUsedId 指向一份不存在的配置就當作沒設", () => {
    expect(normalizeStore({ profiles: [{ id: "a" }], lastUsedId: "沒這個" }).lastUsedId).toBeNull();
  });

  it("⚠ 多開預設關閉 —— 舊設定檔沒有這個欄位時不能繼承成開啟", () => {
    // 這是給「完全不知道有多開這回事」的玩家設計的預設值。這裡回 true 的話，
    // 每個既有使用者升級之後都會突然多出一堆他看不懂的埠號與「開新實例」。
    expect(emptyStore().multiProfile).toBe(false);
    expect(normalizeStore({ profiles: [{ id: "a" }] }).multiProfile).toBe(false);
    expect(normalizeStore({ profiles: [{ id: "a" }], multiProfile: "yes" }).multiProfile).toBe(
      false,
    );
    expect(normalizeStore({ profiles: [{ id: "a" }], multiProfile: true }).multiProfile).toBe(true);
  });

  it('⚠ 舊設定檔的 kind:"web" 要遷成 chrome，不能變回桌面版', () => {
    // 遷丟的話，升級之後那份配置會去接桌面版的 DevToolsActivePort ——
    // 而玩家的遊戲開在瀏覽器裡，畫面上只會寫「等遊戲…」。
    const p = normalizeStore({ profiles: [{ id: "a", kind: "web", port: 59223 }] }).profiles[0];
    expect(p?.kind).toBe("chrome");
    expect(p?.port).toBe(59223);
    // 目錄要跟著換 —— Chrome 的 profile 在 ~\ulr-cdp-profile，不是桌面版那個。
    expect(userDataDirFor(p?.kind ?? "desktop")).toBe(userDataDirFor("chrome"));
  });

  it("舊的自動名「網頁版」換成 Chrome，玩家自己取的名字不動", () => {
    // 「網頁版」是我們填的預設值，留著會出現「名稱：網頁版／客戶端：Chrome」
    // 這種自相矛盾的一列。自己取過名字的人不該被改掉。
    expect(
      normalizeStore({ profiles: [{ id: "a", kind: "web", name: "網頁版" }] }).profiles[0]?.name,
    ).toBe("Chrome");
    expect(
      normalizeStore({ profiles: [{ id: "a", kind: "web", name: "小號" }] }).profiles[0]?.name,
    ).toBe("小號");
  });

  it("認不出來的 kind 一律回桌面版，不要憑空接到某個瀏覽器去", () => {
    expect(normalizeStore({ profiles: [{ id: "a", kind: "firefox" }] }).profiles[0]?.kind).toBe(
      "desktop",
    );
  });

  it("埠不合法就退回預設，不讓實例開不起來", () => {
    expect(clampPort(0, 59222)).toBe(59222);
    expect(clampPort(70000, 59222)).toBe(59222);
    expect(clampPort("abc", 59222)).toBe(59222);
    expect(clampPort(1221, 59222)).toBe(1221);
  });
});

describe("新增", () => {
  it("⚠ 埠不能跟既有的撞 —— 撞到的話第二份根本開不起來", () => {
    // userData 的目錄鎖會擋掉第二個實例，而症狀是「按了開新實例但什麼都沒發生」。
    const s = addTo(addTo(addTo(storeOf(59222), undefined), undefined), undefined);
    const ports = s.profiles.map((p) => p.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("複製出來的是新 id，不是同一份的兩個參照", () => {
    const s = storeOf(59222);
    const source = s.profiles[0] as Profile;
    const next = addTo(s, source);
    expect(next.profiles).toHaveLength(2);
    expect(next.profiles[1]?.id).not.toBe(source.id);
    expect(next.profiles[1]?.port).not.toBe(source.port);
  });

  it("名字重複會加後綴，不會出現兩個一模一樣的", () => {
    const s = storeOf(59222);
    const source = s.profiles[0] as Profile;
    const names = addTo(addTo(s, source), source).profiles.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("刪除", () => {
  it("⚠ 最後一份刪不掉 —— 清單空了沒有任何 UI 救得回來", () => {
    const s = storeOf(59222);
    expect(removeFrom(s, "id0").profiles).toHaveLength(1);
  });

  it("刪掉的那份如果是 lastUsedId，要一起清掉", () => {
    const s: ProfileStore = { ...storeOf(59222, 9334), lastUsedId: "id1" };
    expect(removeFrom(s, "id1").lastUsedId).toBeNull();
  });

  it("刪別的不影響 lastUsedId", () => {
    const s: ProfileStore = { ...storeOf(59222, 9334), lastUsedId: "id0" };
    expect(removeFrom(s, "id1").lastUsedId).toBe("id0");
  });
});

describe("修改", () => {
  it("prefs 是合併的，不是整份換掉", () => {
    const s = storeOf(59222);
    const next = updateIn(s, "id0", { prefs: { speedFactor: 3 } as never });
    expect(next.profiles[0]?.prefs.speedFactor).toBe(3);
    // 沒動到的欄位要留著。整份換掉的話玩家會發現「改了加速，秒數自己跑掉了」。
    expect(next.profiles[0]?.prefs.phaseSeconds).toBe(s.profiles[0]?.prefs.phaseSeconds);
  });

  it("改名不換 id —— 命令列參數帶的是 id", () => {
    const next = updateIn(storeOf(59222), "id0", { name: "主帳號" });
    expect(next.profiles[0]?.id).toBe("id0");
    expect(next.profiles[0]?.name).toBe("主帳號");
  });

  it("換客戶端種類時，自動取的名字要跟著改", () => {
    // 不改的話配置表會出現「名稱：Chrome／客戶端：Edge」，而托盤選單與視窗
    // 標題顯示的都是名稱 —— 玩家之後分不出那一份接的是哪個瀏覽器。
    const s = updateIn(storeOf(59223), "id0", { kind: "chrome", name: "Chrome" });
    expect(updateIn(s, "id0", { kind: "edge" }).profiles[0]?.name).toBe("Edge");
    // addTo 加的數字後綴要留著（「Chrome 2」→「Edge 2」）。
    const numbered = updateIn(s, "id0", { name: "Chrome 2" });
    expect(updateIn(numbered, "id0", { kind: "edge" }).profiles[0]?.name).toBe("Edge 2");
  });

  it("⚠ 玩家自己取的名字不會被換種類改掉", () => {
    const s = updateIn(storeOf(59223), "id0", { kind: "chrome", name: "小號" });
    expect(updateIn(s, "id0", { kind: "edge" }).profiles[0]?.name).toBe("小號");
    // 同一次一起改名的話，他打的那個字優先。
    expect(updateIn(s, "id0", { kind: "edge", name: "打渦的" }).profiles[0]?.name).toBe("打渦的");
  });

  it("改成不合法的埠會被夾回去，不會存進一個開不起來的值", () => {
    expect(updateIn(storeOf(59222), "id0", { port: 0 }).profiles[0]?.port).toBe(
      defaultPortFor("desktop"),
    );
  });
});

describe("這個實例要用哪一份", () => {
  it("--profile 指定的優先", () => {
    const r = resolveProfile(storeOf(59222, 9334), ["--profile", "id1"]);
    expect(r.profile.id).toBe("id1");
    expect(r.ephemeral).toBe(false);
  });

  it("--port 對得上就用那一份（相容舊用法）", () => {
    const r = resolveProfile(storeOf(59222, 9334), ["--port", "9334"]);
    expect(r.profile.id).toBe("id1");
    expect(r.ephemeral).toBe(false);
  });

  it("⚠ --port 對不上時開臨時配置，不是拒絕啟動", () => {
    // 那多半是玩家在試一個新埠。拒絕啟動的話他只會看到程式打不開。
    const r = resolveProfile(storeOf(59222), ["--port", "1221"]);
    expect(r.ephemeral).toBe(true);
    expect(r.profile.port).toBe(1221);
  });

  it("臨時配置的名字裡不放埠 —— 標題會再補一次，變成「臨時 :9334 :9334」", () => {
    expect(resolveProfile(storeOf(59222), ["--port", "1221"]).profile.name).toBe("臨時");
  });

  it("臨時配置也吃 --link（舊的 --link-port 仍然收）", () => {
    const cloud = resolveProfile(storeOf(59222), [
      "--port",
      "1221",
      "--link",
      "wss://x.workers.dev",
    ]);
    expect(cloud.profile.link).toBe("wss://x.workers.dev");
    // 舊用法：純數字 = 本機的那個埠。
    const legacy = resolveProfile(storeOf(59222), ["--port", "1221", "--link-port", "9360"]);
    expect(legacy.profile.link).toBe("9360");
  });

  it("--kind 拿清單裡第一份那種客戶端（開發時 npm run tray 走這條）", () => {
    const s: ProfileStore = {
      ...emptyStore(),
      profiles: [
        { ...defaultProfile("desktop"), id: "id0" },
        { ...defaultProfile("chrome"), id: "id1" },
      ],
    };
    const r = resolveProfile(s, ["--kind", "chrome"]);
    expect(r.profile.id).toBe("id1");
    // ⚠ 不是臨時的 —— 在這個視窗改的設定要存得下來。
    expect(r.ephemeral).toBe(false);
  });

  it("⚠ Chrome 與 Edge 是兩種客戶端，--kind 不會互相拿錯", () => {
    // 拿錯的後果在畫面上看不出來：Edge 那份配置會照 Chrome 的 profile 目錄去
    // 讀 DevToolsActivePort，接上的是另一個帳號的遊戲，而狀態列寫著「已接上」。
    const s: ProfileStore = {
      ...emptyStore(),
      profiles: [
        { ...defaultProfile("chrome"), id: "id0" },
        { ...defaultProfile("edge"), id: "id1" },
      ],
    };
    expect(resolveProfile(s, ["--kind", "edge"]).profile.id).toBe("id1");
    expect(resolveProfile(s, ["--kind", "chrome"]).profile.id).toBe("id0");
    // 兩種的預設埠也必須不同，否則兩個瀏覽器不可能同時掛著。
    expect(defaultPortFor("edge")).not.toBe(defaultPortFor("chrome"));
    expect(userDataDirFor("edge")).not.toBe(userDataDirFor("chrome"));
  });

  it("⚠ --kind 找不到那種客戶端時開臨時的，不是退回桌面版", () => {
    // 退回第一份的話，`npm run tray`（預設 --kind chrome）會安靜地綁上桌面版 ——
    // 而那正是開機自動啟動的安裝版占著的那一個。
    const r = resolveProfile(storeOf(59222), ["--kind", "chrome"]);
    expect(r.ephemeral).toBe(true);
    expect(r.profile.kind).toBe("chrome");
    expect(r.profile.port).toBe(defaultPortFor("chrome"));
  });

  it("⚠ --kind web 是舊的說法，要當成 chrome", () => {
    // 外面還有舊捷徑與舊筆記帶著它。當成「看不懂的值」的話會安靜地綁到桌面版，
    // 而那是開機自動啟動的安裝版占著的那一個。
    const s: ProfileStore = {
      ...emptyStore(),
      profiles: [
        { ...defaultProfile("desktop"), id: "id0" },
        { ...defaultProfile("chrome"), id: "id1" },
      ],
    };
    expect(resolveProfile(s, ["--kind", "web"]).profile.id).toBe("id1");
  });

  it("--profile / --port 比 --kind 優先", () => {
    const r = resolveProfile(storeOf(59222, 9334), ["--kind", "chrome", "--port", "9334"]);
    expect(r.profile.id).toBe("id1");
  });

  it("--kind 給了看不懂的值就當作沒給", () => {
    expect(resolveProfile(storeOf(59222, 9334), ["--kind", "firefox"]).profile.id).toBe("id0");
  });

  it("⚠ 什麼都沒帶就用**第一份**，不看上次用的那份", () => {
    // 「記住上次」在多開的人身上很方便，在其他人身上是「我只是想開插件，
    // 它卻綁到上次測試用的網頁版」，而畫面上只寫「等遊戲…」。
    const s: ProfileStore = { ...storeOf(59222, 9334), lastUsedId: "id1" };
    expect(resolveProfile(s, []).profile.id).toBe("id0");
    expect(resolveProfile(s, []).profile.port).toBe(59222);
  });

  it("--profile 指到不存在的 id 就退回第一份，不要開不起來", () => {
    const s: ProfileStore = { ...storeOf(59222, 9334), lastUsedId: "id1" };
    expect(resolveProfile(s, ["--profile", "沒這個"]).profile.id).toBe("id0");
  });

  it("新安裝的第一份就是桌面版 :59222", () => {
    expect(emptyStore().profiles[0]?.kind).toBe("desktop");
    expect(emptyStore().profiles[0]?.port).toBe(defaultPortFor("desktop"));
  });

  // --- 自訂 COST 規則路徑 ---------------------------------------------------

  it("新裝就套用插件附的那一份規則（v1.1 起）", () => {
    expect(defaultProfile("desktop").costRuleMode).toBe("default");
    // 路徑仍然是空的 —— 預設規則不走 `costRulePath`，它是「玩家自己選的檔」那一格。
    expect(defaultProfile("desktop").costRulePath).toBeNull();
  });

  it("舊設定檔沒有這個欄位 → null，不是 undefined", () => {
    // undefined 會讓 UI 的 `?? null` 之外的判斷（例如 JSON 往返）行為不一致。
    const p = normalizeProfile({ id: "x", name: "舊的", port: 59222 });
    expect(p?.costRulePath).toBeNull();
  });

  // --- 規則來源（default / file / off）--------------------------------------

  it("⚠ 從來沒選過規則的舊使用者會開始套用預設規則", () => {
    // 這是一次刻意的行為改變：自訂 COST 要成為一個環境，就不能要求每個人
    // 先做一次設定，而「先自己去選一份規則檔」正是大多數人不會做的那一步。
    const p = normalizeProfile({ id: "x", name: "舊的", port: 59222 });
    expect(p?.costRuleMode).toBe("default");
  });

  it("已經選過檔的舊使用者不受影響 —— 他的檔還是他的檔", () => {
    const path = String.raw`E:\rules\mine.ulrcost.json`;
    const p = normalizeProfile({ id: "x", port: 59222, costRulePath: path });
    expect(p?.costRuleMode).toBe("file");
    expect(p?.costRulePath).toBe(path);
  });

  it("⚠ 明確停用過的人不會被預設值蓋回去", () => {
    const p = normalizeProfile({ id: "x", port: 59222, costRuleMode: "off" });
    expect(p?.costRuleMode).toBe("off");
  });

  it("看不懂的值退回預設", () => {
    expect(normalizeProfile({ id: "x", port: 59222, costRuleMode: "亂寫" })?.costRuleMode).toBe(
      "default",
    );
    expect(normalizeProfile({ id: "x", port: 59222, costRuleMode: 42 })?.costRuleMode).toBe(
      "default",
    );
  });

  it("切到預設模式時**不會**把玩家選過的路徑清掉", () => {
    // 切回去的時候不必重選一次 —— 那一格是他的，不是模式的。
    const path = String.raw`E:\rules\mine.ulrcost.json`;
    const p = normalizeProfile({
      id: "x",
      port: 59222,
      costRulePath: path,
      costRuleMode: "default",
    });
    expect(p?.costRuleMode).toBe("default");
    expect(p?.costRulePath).toBe(path);
  });

  it("路徑原樣留著 —— 這是檔案系統的字串，不能正規化掉", () => {
    const win = String.raw`E:\ulr-companion\rules\my.ulrcost.json`;
    expect(normalizeProfile({ id: "x", port: 59222, costRulePath: win })?.costRulePath).toBe(win);
  });

  it("空字串與空白當成沒選，不要留一個看不見的假選擇", () => {
    expect(normalizeProfile({ id: "x", port: 59222, costRulePath: "" })?.costRulePath).toBeNull();
    expect(
      normalizeProfile({ id: "x", port: 59222, costRulePath: "   " })?.costRulePath,
    ).toBeNull();
  });

  it("非字串一律當成沒選", () => {
    expect(normalizeProfile({ id: "x", port: 59222, costRulePath: 42 })?.costRulePath).toBeNull();
  });

  // --- 隱藏地圖 -------------------------------------------------------------

  it("預設關閉 —— 裝了插件不該改變玩家在遊戲裡看到的選單", () => {
    expect(defaultProfile("desktop").hiddenStages).toBe(false);
  });

  it("舊設定檔沒有這個欄位 → false，不是 undefined", () => {
    // ⚠ `=== true` 而不是「有值就算」：舊檔的預設就該是關閉。
    expect(normalizeProfile({ id: "x", port: 59222 })?.hiddenStages).toBe(false);
    expect(normalizeProfile({ id: "x", port: 59222, hiddenStages: "yes" })?.hiddenStages).toBe(
      false,
    );
  });

  it("記在配置裡才活得過遊戲重載 —— 存了要讀得回來", () => {
    expect(normalizeProfile({ id: "x", port: 59222, hiddenStages: true })?.hiddenStages).toBe(true);
  });
  // --- 自動配對的開房設定 ---------------------------------------------------

  it("舊設定檔沒有 match 這一欄 → 拿到一份可用的預設", () => {
    expect(normalizeProfile({ id: "x", port: 59222 })?.match).toEqual(DEFAULT_MATCH_PREFS);
  });

  /**
   * ⚠ 房名這一格**整個拿掉了** —— 現在由系統照「規則名 + 檔位」組
   * （`@ulr/arbiter-engine` 的 `buildRoomName`）。舊設定檔裡那個字串不搬過來，
   * 也不留在物件上：留著的話下一個讀這支的人會以為它還有效，而它不會被用到。
   */
  it("舊設定檔的房名不搬過來 —— 房名現在是系統取的", () => {
    const p = normalizeProfile({ id: "x", port: 59222, match: { roomName: "蕭恩的房" } });
    expect(p?.match).not.toHaveProperty("roomName");
  });

  /**
   * ⚠ 「約定 COST 檔位」那兩格**整個拿掉了**（WP-18）：檔位改成照牌組算
   * （`@ulr/arbiter-engine` 的 `tierForTotal` / `bandForTotal`）。舊設定檔裡
   * 那兩個值不搬過來，也不留在物件上 —— 它們**進配對鍵**，一個沒有 UI 顯示
   * 也改不掉的舊值會讓玩家排在一條沒有人的隊伍上。
   */
  it("舊設定檔的約定檔位不搬過來 —— 檔位現在照牌組算", () => {
    const p = normalizeMatchPrefs({ limitOn: true, limit: 62 });
    expect(p).not.toHaveProperty("limitOn");
    expect(p).not.toHaveProperty("limit");
  });

  /**
   * ⚠ 「對戰規則」與「牌組Cost限制 ±N」兩格**整個拿掉了**：插件開的房固定
   * 3vs3、固定不設 ±N（`@ulr/arbiter-engine` 的 `ROOM_MULTI` 與
   * `ROOM_DECK_COST_BAND`）。舊設定檔裡那三個值不搬過來，也不留在物件上 ——
   * 留著的話下一個讀這支的人會以為它們還有效，尤其 `multi` 還**進配對鍵**，
   * 一個沒有 UI 顯示也改不掉的舊值會讓玩家排在一條沒有人的隊伍上。
   */
  it("舊設定檔的 multi 與 ±N 不搬過來 —— 開房固定 3vs3、不設 ±N", () => {
    const p = normalizeMatchPrefs({ multi: false, bandOn: true, band: 3 });
    expect(p).not.toHaveProperty("multi");
    expect(p).not.toHaveProperty("bandOn");
    expect(p).not.toHaveProperty("band");
  });

  it("地點那格收兩種抽法與 000~013，認不得的退回亞城池", () => {
    expect(normalizeMatchPrefs({ stage: "arcadia" }).stage).toBe("arcadia");
    expect(normalizeMatchPrefs({ stage: "official" }).stage).toBe("official");
    expect(normalizeMatchPrefs({ stage: "007" }).stage).toBe("007");
    expect(normalizeMatchPrefs({ stage: "013" }).stage).toBe("013");
    expect(normalizeMatchPrefs({ stage: "../etc" }).stage).toBe("arcadia");
    expect(normalizeMatchPrefs({ stage: "099" }).stage).toBe("arcadia");
    expect(normalizeMatchPrefs({ stage: 13 }).stage).toBe("arcadia");
  });

  /**
   * ⚠ `014` 是**官方選單裡的「隨機」**，不是一張地圖。舊設定檔（與中間某一版
   * 只有兩種抽法的設定檔）存過它，而它的意思正是「不要插件替我抽」。
   */
  it("舊設定檔的 014 是「官方隨機」，不是一張地圖", () => {
    expect(normalizeMatchPrefs({ stage: "014" }).stage).toBe("official");
  });
});

/**
 * 編輯 COST 的上下鍵幅度
 *
 * ⚠ 這一組真正在守的是 **0**。`<input step="0">` 在 Chromium 裡等於上下鍵
 * 完全不動 —— 而那看起來就是鍵盤壞了，不是設定錯了，玩家不會想到要回來改
 * 這一格。負數更糟：上鍵變成往下。
 */
describe("上下鍵的幅度", () => {
  it("五個快速鍵原封不動收下", () => {
    for (const n of [1, 0.5, 0.1, 0.05, 0.01]) expect(normalizeEditStep(n)).toBe(n);
  });

  it("自己打的數字也收 —— 這一格本來就開放自訂", () => {
    expect(normalizeEditStep(2.5)).toBe(2.5);
    expect(normalizeEditStep("0.25")).toBe(0.25);
  });

  it("⚠ 0 與負數一律退回預設 —— 那兩個會讓上下鍵看起來壞掉", () => {
    expect(normalizeEditStep(0)).toBe(DEFAULT_EDIT_STEP);
    expect(normalizeEditStep(-1)).toBe(DEFAULT_EDIT_STEP);
    // 夾成兩位小數之後變 0 的也一樣（0.004 → 0.00）。
    expect(normalizeEditStep(0.004)).toBe(DEFAULT_EDIT_STEP);
  });

  it("看不懂的、太大的也退回預設", () => {
    expect(normalizeEditStep(undefined)).toBe(DEFAULT_EDIT_STEP);
    expect(normalizeEditStep("每次一點點")).toBe(DEFAULT_EDIT_STEP);
    expect(normalizeEditStep(Number.NaN)).toBe(DEFAULT_EDIT_STEP);
    expect(normalizeEditStep(101)).toBe(DEFAULT_EDIT_STEP);
  });

  it("夾到兩位小數 —— 跟價格同一條線", () => {
    expect(normalizeEditStep(0.123)).toBe(0.12);
  });

  it("舊設定檔沒有這一欄 → 1（整數）", () => {
    expect(normalizeProfile({ id: "a", name: "舊的", port: 9333 })?.editStep).toBe(1);
    expect(defaultProfile("desktop").editStep).toBe(1);
  });
});

/**
 * 最小單位（檢查用）
 *
 * ⚠ 這一組守的東西跟上下鍵幅度**剛好相反**：那邊的 0 是壞值（上下鍵會不動），
 * 這邊的 0 是**合法且是預設**的值 —— 它的意思是「不檢查」。兩個都夾到兩位
 * 小數，但退路完全不同，所以不能共用一支正規化。
 *
 * ⚠ 這個值**不寫進規則檔**。它是編輯器的工具設定；作者要宣告最小單位是自己
 * 寫進描述欄的（見 `normalizeEditUnit` 的說明）。
 */
describe("最小單位", () => {
  it("快速鍵原封不動收下 —— 這幾個都除得盡 1", () => {
    for (const n of EDIT_UNITS) expect(normalizeEditUnit(n)).toBe(n);
  });

  it("⚠ 每一個快速鍵都要湊得出剛好 1C —— 那是這幾顆存在的理由", () => {
    for (const n of EDIT_UNITS) expect(100 % Math.round(n * 100)).toBe(0);
  });

  it("自己打的數字也收，包含除不盡 1 的 0.33", () => {
    expect(normalizeEditUnit(0.33)).toBe(0.33);
    expect(normalizeEditUnit("0.25")).toBe(0.25);
  });

  it("⚠ 0 是合法的 —— 它的意思是「不檢查」，不是壞值", () => {
    expect(normalizeEditUnit(0)).toBe(0);
  });

  it("負數、看不懂的、太大的一律回 0（不檢查），不是回某個單位", () => {
    // ⚠ 退回一個「單位」的話，插件等於替作者憑空宣告了一條他沒同意的約束，
    // 然後把一整張合法的表標成不合。壞值的正確退路是「不管」。
    expect(normalizeEditUnit(-1)).toBe(0);
    expect(normalizeEditUnit(undefined)).toBe(0);
    expect(normalizeEditUnit("三分之一")).toBe(0);
    expect(normalizeEditUnit(Number.NaN)).toBe(0);
    expect(normalizeEditUnit(101)).toBe(0);
  });

  it("夾到兩位小數；夾完變 0 的就是不檢查", () => {
    expect(normalizeEditUnit(0.123)).toBe(0.12);
    expect(normalizeEditUnit(0.004)).toBe(0);
  });

  it("舊設定檔沒有這一欄 → 0（不檢查）", () => {
    expect(normalizeProfile({ id: "a", name: "舊的", port: 9333 })?.editUnit).toBe(0);
    expect(defaultProfile("desktop").editUnit).toBe(0);
  });
});
