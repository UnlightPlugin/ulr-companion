import { describe, expect, it } from "vitest";
import { DEFAULT_LINK_TARGET } from "@ulr/arbiter-link";
import type { Profile, ProfileStore } from "../src/profiles-core.js";
import {
  addTo,
  clampPort,
  defaultPortFor,
  defaultProfile,
  emptyStore,
  normalizeStore,
  removeFrom,
  resolveProfile,
  updateIn,
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

  it("埠不合法就退回預設，不讓實例開不起來", () => {
    expect(clampPort(0, 9333)).toBe(9333);
    expect(clampPort(70000, 9333)).toBe(9333);
    expect(clampPort("abc", 9333)).toBe(9333);
    expect(clampPort(1221, 9333)).toBe(1221);
  });
});

describe("新增", () => {
  it("⚠ 埠不能跟既有的撞 —— 撞到的話第二份根本開不起來", () => {
    // userData 的目錄鎖會擋掉第二個實例，而症狀是「按了開新實例但什麼都沒發生」。
    const s = addTo(addTo(addTo(storeOf(9333), undefined), undefined), undefined);
    const ports = s.profiles.map((p) => p.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("複製出來的是新 id，不是同一份的兩個參照", () => {
    const s = storeOf(9333);
    const source = s.profiles[0] as Profile;
    const next = addTo(s, source);
    expect(next.profiles).toHaveLength(2);
    expect(next.profiles[1]?.id).not.toBe(source.id);
    expect(next.profiles[1]?.port).not.toBe(source.port);
  });

  it("名字重複會加後綴，不會出現兩個一模一樣的", () => {
    const s = storeOf(9333);
    const source = s.profiles[0] as Profile;
    const names = addTo(addTo(s, source), source).profiles.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("刪除", () => {
  it("⚠ 最後一份刪不掉 —— 清單空了沒有任何 UI 救得回來", () => {
    const s = storeOf(9333);
    expect(removeFrom(s, "id0").profiles).toHaveLength(1);
  });

  it("刪掉的那份如果是 lastUsedId，要一起清掉", () => {
    const s: ProfileStore = { ...storeOf(9333, 9334), lastUsedId: "id1" };
    expect(removeFrom(s, "id1").lastUsedId).toBeNull();
  });

  it("刪別的不影響 lastUsedId", () => {
    const s: ProfileStore = { ...storeOf(9333, 9334), lastUsedId: "id0" };
    expect(removeFrom(s, "id1").lastUsedId).toBe("id0");
  });
});

describe("修改", () => {
  it("prefs 是合併的，不是整份換掉", () => {
    const s = storeOf(9333);
    const next = updateIn(s, "id0", { prefs: { speedFactor: 3 } as never });
    expect(next.profiles[0]?.prefs.speedFactor).toBe(3);
    // 沒動到的欄位要留著。整份換掉的話玩家會發現「改了加速，秒數自己跑掉了」。
    expect(next.profiles[0]?.prefs.phaseSeconds).toBe(s.profiles[0]?.prefs.phaseSeconds);
  });

  it("改名不換 id —— 命令列參數帶的是 id", () => {
    const next = updateIn(storeOf(9333), "id0", { name: "主帳號" });
    expect(next.profiles[0]?.id).toBe("id0");
    expect(next.profiles[0]?.name).toBe("主帳號");
  });

  it("改成不合法的埠會被夾回去，不會存進一個開不起來的值", () => {
    expect(updateIn(storeOf(9333), "id0", { port: 0 }).profiles[0]?.port).toBe(
      defaultPortFor("desktop"),
    );
  });
});

describe("這個實例要用哪一份", () => {
  it("--profile 指定的優先", () => {
    const r = resolveProfile(storeOf(9333, 9334), ["--profile", "id1"]);
    expect(r.profile.id).toBe("id1");
    expect(r.ephemeral).toBe(false);
  });

  it("--port 對得上就用那一份（相容舊用法）", () => {
    const r = resolveProfile(storeOf(9333, 9334), ["--port", "9334"]);
    expect(r.profile.id).toBe("id1");
    expect(r.ephemeral).toBe(false);
  });

  it("⚠ --port 對不上時開臨時配置，不是拒絕啟動", () => {
    // 那多半是玩家在試一個新埠。拒絕啟動的話他只會看到程式打不開。
    const r = resolveProfile(storeOf(9333), ["--port", "1221"]);
    expect(r.ephemeral).toBe(true);
    expect(r.profile.port).toBe(1221);
  });

  it("臨時配置的名字裡不放埠 —— 標題會再補一次，變成「臨時 :9334 :9334」", () => {
    expect(resolveProfile(storeOf(9333), ["--port", "1221"]).profile.name).toBe("臨時");
  });

  it("臨時配置也吃 --link（舊的 --link-port 仍然收）", () => {
    const cloud = resolveProfile(storeOf(9333), [
      "--port",
      "1221",
      "--link",
      "wss://x.workers.dev",
    ]);
    expect(cloud.profile.link).toBe("wss://x.workers.dev");
    // 舊用法：純數字 = 本機的那個埠。
    const legacy = resolveProfile(storeOf(9333), ["--port", "1221", "--link-port", "9360"]);
    expect(legacy.profile.link).toBe("9360");
  });

  it("⚠ 什麼都沒帶就用**第一份**，不看上次用的那份", () => {
    // 「記住上次」在多開的人身上很方便，在其他人身上是「我只是想開插件，
    // 它卻綁到上次測試用的網頁版」，而畫面上只寫「等遊戲…」。
    const s: ProfileStore = { ...storeOf(9333, 9334), lastUsedId: "id1" };
    expect(resolveProfile(s, []).profile.id).toBe("id0");
    expect(resolveProfile(s, []).profile.port).toBe(9333);
  });

  it("--profile 指到不存在的 id 就退回第一份，不要開不起來", () => {
    const s: ProfileStore = { ...storeOf(9333, 9334), lastUsedId: "id1" };
    expect(resolveProfile(s, ["--profile", "沒這個"]).profile.id).toBe("id0");
  });

  it("新安裝的第一份就是桌面版 :9333", () => {
    expect(emptyStore().profiles[0]?.kind).toBe("desktop");
    expect(emptyStore().profiles[0]?.port).toBe(defaultPortFor("desktop"));
  });
});
