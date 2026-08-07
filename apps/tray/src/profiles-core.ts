/**
 * 具名配置的規則（純函式，無 I/O）
 * ==================================
 * 多開的骨架。一份配置 = 「一個遊戲客戶端要怎麼接」，玩家在設定頁維護一張
 * 清單，按「開新實例」就再開一個托盤視窗綁另一份 —— MAA 的「切換配置」是
 * 同一個形狀，理由也一樣：**埠寫在命令列的話，一般玩家永遠開不了第二個。**
 *
 * ⚠ **這個檔案不 import electron。** 落地在 `profiles.ts`，規則在這裡。
 * 分開的理由跟 `arbiter-link/protocol.ts` 一樣：這裡面有三條「錯了會安靜地
 * 壞掉」的規則，而它們必須測得到 ——
 *
 * 1. 兩份配置**不能用同一個遊戲埠**（撞到的話第二份根本開不起來）
 * 2. **最後一份刪不掉**（清單空了視窗沒有東西可綁，而且沒有 UI 救得回來）
 * 3. `--port` 對不上任何配置時要開**臨時配置**，不是拒絕啟動
 */

import type { LinkPrefs } from "@ulr/arbiter-link";
import { DEFAULT_LINK_PORT, normalizePrefs } from "@ulr/arbiter-link";
import { DEFAULT_DEBUG_PORT, normalizeTint } from "@ulr/cdp-adapter";

/** 客戶端種類。只影響提示文字與預設埠，不影響接線方式（兩邊都是 CDP）。 */
export type ClientKind = "desktop" | "web";

export interface Profile {
  /** 穩定識別。改名不會換 id —— 命令列參數帶的是它。 */
  id: string;
  name: string;
  /** 遊戲的 CDP 埠。**這也是實例的身分**（見 `main.ts` 的 userData 分離）。 */
  port: number;
  /** 中間人的埠。要跟對手用同一個，預設值就是為了不用設定。 */
  linkPort: number;
  kind: ClientKind;
  prefs: LinkPrefs;
  /**
   * 準備中把 OK 鈕染成什麼顏色。`null` = 不染色（官方原本的樣子），預設。
   *
   * ⚠ **跟 `prefs` 分開放。** `prefs` 是 `LinkPrefs`，那是會送給對手協商的
   * 東西；顏色只改我自己畫面上的一個像素，對手看不到也拿不到好處。混在一起
   * 的話，改個顏色就會觸發一次協商廣播。
   */
  readyTint: number | null;
}

export interface ProfileStore {
  profiles: Profile[];
  /** 最後一次開的那份。下次不帶參數啟動就用它。 */
  lastUsedId: string | null;
  /**
   * 隨 Windows 開機啟動。
   *
   * ⚠ 這是**整個程式**的設定，不是某一份配置的。放在配置裡的話，玩家會遇到
   * 「我在小號那份關掉了，主帳號那份又把它打開」。
   */
  launchAtLogin: boolean;
  /** 啟動時不要跳視窗，只留托盤圖示。 */
  startMinimized: boolean;
}

const DESKTOP_PORT = DEFAULT_DEBUG_PORT;
/** 網頁版的預設埠。`docs/launching.md`：`companion web` 開的瀏覽器就用這個。 */
const WEB_PORT = 9334;

export function defaultPortFor(kind: ClientKind): number {
  return kind === "web" ? WEB_PORT : DESKTOP_PORT;
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `p${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 埠要是合法的 TCP 埠。壞掉的值一律退回預設，不讓實例開不起來。 */
export function clampPort(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export function normalizeProfile(raw: unknown): Profile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" && r["id"].length > 0 ? r["id"] : newId();
  const kind: ClientKind = r["kind"] === "web" ? "web" : "desktop";
  const raw2 = typeof r["name"] === "string" ? r["name"].trim() : "";
  return {
    id,
    name: raw2 === "" ? (kind === "web" ? "網頁版" : "桌面版") : raw2,
    port: clampPort(r["port"], defaultPortFor(kind)),
    linkPort: clampPort(r["linkPort"], DEFAULT_LINK_PORT),
    kind,
    prefs: normalizePrefs(r["prefs"] as Partial<LinkPrefs> | undefined),
    readyTint: normalizeTint(typeof r["readyTint"] === "number" ? r["readyTint"] : null),
  };
}

export function defaultProfile(kind: ClientKind = "desktop"): Profile {
  return {
    id: newId(),
    name: kind === "web" ? "網頁版" : "桌面版",
    port: defaultPortFor(kind),
    linkPort: DEFAULT_LINK_PORT,
    kind,
    prefs: normalizePrefs(undefined),
    // 預設不染色 —— 玩家指定「官方原本的白色」是預設值。
    readyTint: null,
  };
}

export function emptyStore(): ProfileStore {
  return {
    profiles: [defaultProfile("desktop")],
    lastUsedId: null,
    launchAtLogin: false,
    startMinimized: false,
  };
}

/**
 * 把讀進來的東西整理成一份能用的清單。
 *
 * **壞掉、缺欄位、空清單一律回一份可用的預設，絕不拋例外。** 這裡拋例外的
 * 代價是托盤根本開不起來，而玩家看不到任何原因（沒有視窗可以顯示錯誤）。
 */
export function normalizeStore(raw: unknown): ProfileStore {
  if (typeof raw !== "object" || raw === null) return emptyStore();
  const r = raw as Record<string, unknown>;

  const profiles = (Array.isArray(r["profiles"]) ? r["profiles"] : [])
    .map(normalizeProfile)
    .filter((p): p is Profile => p !== null);
  // 一份都沒有的話清單是不能用的 —— 視窗會沒有東西可綁。
  if (profiles.length === 0) return emptyStore();

  const ids = new Set(profiles.map((p) => p.id));
  const lastUsedId = typeof r["lastUsedId"] === "string" ? r["lastUsedId"] : null;
  return {
    profiles,
    lastUsedId: lastUsedId !== null && ids.has(lastUsedId) ? lastUsedId : null,
    launchAtLogin: r["launchAtLogin"] === true,
    startMinimized: r["startMinimized"] === true,
  };
}

/**
 * 新增一份（`source` 有給就是「複製」）。
 *
 * ⚠ **埠撞在一起的兩份配置不能同時跑** —— userData 的目錄鎖會擋掉第二個，
 * 而症狀是「按了開新實例但什麼都沒發生」，完全查不出原因。所以新增的當下
 * 就先挑一個沒人用的埠，不要把這個問題留到玩家按下去才爆。
 */
export function addTo(store: ProfileStore, source?: Profile): ProfileStore {
  const base = source ?? defaultProfile(store.profiles.length === 0 ? "desktop" : "web");

  const used = new Set(store.profiles.map((p) => p.port));
  let port = base.port;
  while (used.has(port)) port += 1;

  const names = new Set(store.profiles.map((p) => p.name));
  const stem = source === undefined ? base.name : `${base.name} 複本`;
  let name = stem;
  for (let i = 2; names.has(name); i++) name = `${stem} ${i}`;

  const created: Profile = { ...base, id: newId(), name, port };
  return { ...store, profiles: [...store.profiles, created] };
}

/**
 * 刪一份。**最後一份刪不掉** —— 清單空了視窗就沒有東西可綁，
 * 而那個狀態沒有任何 UI 可以救回來。
 */
export function removeFrom(store: ProfileStore, id: string): ProfileStore {
  if (store.profiles.length <= 1) return store;
  return {
    ...store,
    profiles: store.profiles.filter((p) => p.id !== id),
    lastUsedId: store.lastUsedId === id ? null : store.lastUsedId,
  };
}

/** 改一份，其餘照舊。`prefs` 是合併的，不是整份換掉。 */
export function updateIn(
  store: ProfileStore,
  id: string,
  patch: Partial<Omit<Profile, "id">>,
): ProfileStore {
  return {
    ...store,
    profiles: store.profiles.map((p) => {
      if (p.id !== id) return p;
      const merged = { ...p, ...patch, id, prefs: { ...p.prefs, ...(patch.prefs ?? {}) } };
      return normalizeProfile(merged) ?? p;
    }),
  };
}

/**
 * 這個實例要用哪一份配置。
 *
 * 優先序：`--profile <id>` → `--port <n>` 對得上的那份 → 上次用的 → 第一份。
 *
 * ⚠ `--port` 那條是為了**相容舊的用法**（`npm run tray -- --port 9333`）。
 * 對不上任何配置時不要當作錯誤：那多半是玩家在試一個新埠，直接臨時建一份
 * 不落地的配置給他用，比拒絕啟動有用得多。
 */
export function resolveProfile(
  store: ProfileStore,
  argv: readonly string[],
): { profile: Profile; ephemeral: boolean } {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const wantId = flag("profile");
  if (wantId !== undefined) {
    const hit = store.profiles.find((p) => p.id === wantId);
    if (hit !== undefined) return { profile: hit, ephemeral: false };
  }

  const wantPort = flag("port");
  if (wantPort !== undefined) {
    const port = clampPort(wantPort, 0);
    const hit = store.profiles.find((p) => p.port === port);
    if (hit !== undefined) return { profile: hit, ephemeral: false };
    if (port > 0) {
      const linkPort = clampPort(flag("link-port"), DEFAULT_LINK_PORT);
      // 名字裡不要放埠 —— 視窗標題與狀態列本來就會補上，會變成「臨時 :9334 :9334」。
      return {
        profile: { ...defaultProfile("desktop"), name: "臨時", port, linkPort },
        ephemeral: true,
      };
    }
  }

  const last =
    store.lastUsedId === null ? undefined : store.profiles.find((p) => p.id === store.lastUsedId);
  // `profiles` 保證非空（`normalizeStore` 會補一份），所以最後那個 ?? 只是給型別看的。
  return { profile: last ?? store.profiles[0] ?? defaultProfile("desktop"), ephemeral: false };
}
