/**
 * 配置的落地
 * ============
 * 規則全部在 `profiles-core.ts`（純函式，測得到）。這裡只做 I/O：
 * 讀檔、寫檔，以及**多個實例同時寫同一個檔案**的處理。
 *
 * ⚠ **這個檔案存在共用位置，不在 per-instance 的 userData 底下。**
 * `main.ts` 會把 userData 依埠分開（那是兩個 Electron 實例不打架的關鍵），
 * 但配置清單本身必須是**所有實例看到同一份**，否則「在 A 視窗新增的配置
 * 在 B 視窗看不到」。
 *
 * ⚠ **每次寫入都先重讀。** 直接把記憶體裡那份寫回去的話，B 視窗存檔會把
 * A 視窗剛剛新增的配置抹掉。這不是理論問題：兩個視窗本來就是預期用法。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { Profile, ProfileStore } from "./profiles-core.js";
import { addTo, emptyStore, normalizeStore, removeFrom, updateIn } from "./profiles-core.js";

export type { ClientKind, Profile, ProfileStore } from "./profiles-core.js";
export { defaultPortFor, resolveProfile, userDataDirFor } from "./profiles-core.js";

/**
 * 配置清單存在哪。
 *
 * ⚠ 用 `appData` 而不是 `userData` —— 後者已經被 `main.ts` 依埠改掉了，
 * 存進去的話每個實例都會有自己的一份清單，「多開」就永遠只看得到自己。
 */
export function storePath(): string {
  return join(app.getPath("appData"), "ulr-companion", "profiles.json");
}

export function loadStore(): ProfileStore {
  try {
    const path = storePath();
    if (!existsSync(path)) return emptyStore();
    return normalizeStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyStore();
  }
}

/**
 * 寫回去。**先寫暫存檔再 rename**，避免寫到一半被中斷而留下半份 JSON
 * （那會讓下次啟動整份設定被當成壞檔丟掉）。檔名帶 pid 是因為兩個實例
 * 可能同時在寫，共用一個暫存檔名會互相截斷。
 */
function writeStore(store: ProfileStore): ProfileStore {
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch {
    // 存不起來不該讓功能停掉 —— 這一輪的設定仍然在記憶體裡生效。
  }
  return store;
}

/** 讀 → 套規則 → 寫。**先重讀**是為了不蓋掉另一個實例的變更。 */
function mutate(fn: (store: ProfileStore) => ProfileStore): ProfileStore {
  return writeStore(fn(loadStore()));
}

export function updateProfile(id: string, patch: Partial<Omit<Profile, "id">>): ProfileStore {
  return mutate((s) => updateIn(s, id, patch));
}

export function addProfile(source?: Profile): ProfileStore {
  return mutate((s) => addTo(s, source));
}

export function removeProfile(id: string): ProfileStore {
  return mutate((s) => removeFrom(s, id));
}

export function updateOptions(
  patch: Partial<Pick<ProfileStore, "launchAtLogin" | "startMinimized" | "multiProfile">>,
): ProfileStore {
  return mutate((s) => ({ ...s, ...patch }));
}

export function markUsed(id: string): void {
  mutate((s) => (s.lastUsedId === id ? s : { ...s, lastUsedId: id }));
}
