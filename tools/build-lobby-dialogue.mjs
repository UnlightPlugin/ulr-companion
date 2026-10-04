/* global console, process, fetch */
// 重產首頁立繪的台詞表（點立繪說的話）
// ====================================
//   node tools/build-lobby-dialogue.mjs [Dialogues.csv DialogueWeights.csv]
//
// 對戰開場的台詞是伺服器開房時才送（room_config.dialogue = { id, content }），客戶端沒有整張表。
// 來源是原版 Unlight 開源碼（open-unlight/Unlight，MIT）的 app/server/data/csv/ja/ 下的
// Dialogues.csv（id → 各語言台詞）與 DialogueWeights.csv（誰對誰、哪個等級說哪一句）；
// 沒給路徑就從 GitHub 抓 master。寫到 packages/cdp-adapter/src/lobby-dialogue-data.ts，
// 跑完再 npm run format。
//
// 只收 dialogue_type 0（對戰開場；2 是任務開場、3／6 是任務結束），只收可玩角色（chara_id < 1000）：
//   other_chara_id == chara_id → 一般台詞（不挑對手）
//   其他                       → 對那個角色說的
// 台詞 id 跟語音對得上：CharaVoice 的 cc001_dialogue106 就是 id 106。
//
// 2026-10-03 對過：ULR 70 個可玩角色有 68 個有台詞，cc056、cc078（ULR 新角色）沒有。

import { readFileSync, writeFileSync } from "node:fs";

const BASE =
  "https://raw.githubusercontent.com/open-unlight/Unlight/master/app/server/data/csv/ja/";
const OUT = new globalThis.URL(
  "../packages/cdp-adapter/src/lobby-dialogue-data.ts",
  import.meta.url,
);
/** 收哪幾種語言（遊戲的 lang 值 → CSV 欄位）。順序就是輸出陣列的順序。 */
const LANGS = [
  ["ja", "content"],
  ["tcn", "content_tcn"],
  ["scn", "content_scn"],
  ["en", "content_en"],
  ["kr", "content_kr"],
];

async function load(path, name) {
  if (path) return readFileSync(path, "utf8");
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`抓不到 ${name}：HTTP ${r.status}`);
  return r.text();
}

/** CSV：雙引號包的欄位裡可以有逗號、換行（日文台詞有兩行的）。 */
function parse(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  const t = text.replace(new RegExp("^" + String.fromCharCode(0xfeff)), "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function table(text) {
  const [head, ...rows] = parse(text);
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const dialogues = table(await load(process.argv[2], "Dialogues.csv"));
const weights = table(await load(process.argv[3], "DialogueWeights.csv"));

const key = (id) => `cc${String(id).padStart(3, "0")}`;
const charas = {};
const used = new Set();
for (const w of weights) {
  if (w.dialogue_type !== "0") continue;
  const me = Number(w.chara_id);
  const other = Number(w.other_chara_id);
  const id = Number(w.dialogue_id);
  if (!(me > 0 && me < 1000) || !(other > 0 && other < 1000) || !(id > 0)) continue;
  const c = (charas[key(me)] ??= { general: [], vs: {} });
  const list = other === me ? c.general : (c.vs[key(other)] ??= []);
  if (!list.includes(id)) list.push(id);
  used.add(id);
}

const lines = {};
for (const d of dialogues) {
  const id = Number(d.id);
  if (!used.has(id)) continue;
  lines[id] = LANGS.map(([, col]) => (d[col] ?? "").trim());
}
const missing = [...used].filter((id) => !(id in lines));
if (missing.length > 0) throw new Error(`DialogueWeights 指到不存在的台詞：${missing.join(", ")}`);

const sortedCharas = Object.fromEntries(
  Object.keys(charas)
    .sort()
    .map((k) => [k, charas[k]]),
);
const out = `/**
 * 首頁立繪的台詞表 —— **產生的檔案，不要手改。**
 * 重產：node tools/build-lobby-dialogue.mjs（說明在那支檔頭），跑完 npm run format。
 *
 * 來源：原版 Unlight 開源碼（open-unlight/Unlight，MIT）的 Dialogues.csv ＋ DialogueWeights.csv，
 * 只收對戰開場（dialogue_type 0）、可玩角色。
 */

/** 每句台詞的語言順序（遊戲的 \`lang\` 值）。 */
export const LOBBY_DIALOGUE_LANGS = ${JSON.stringify(LANGS.map(([l]) => l))} as const;

/** 台詞 id → 各語言（順序照 {@link LOBBY_DIALOGUE_LANGS}；日文可能有換行）。id 跟語音的 dialogueNNN 同一套。 */
export const LOBBY_DIALOGUE_LINES: Record<string, readonly string[]> = ${JSON.stringify(lines)};

/** 角色 → 一般台詞 id、對特定角色說的台詞 id。 */
export const LOBBY_DIALOGUE_CHARAS: Record<
  string,
  { general: readonly number[]; vs: Record<string, readonly number[]> }
> = ${JSON.stringify(sortedCharas)};
`;
writeFileSync(OUT, out);
console.log(
  `寫了 ${OUT.pathname}：${Object.keys(sortedCharas).length} 個角色、${Object.keys(lines).length} 句`,
);
