// 重產任務格子的寶箱表（treasure_no → 實際是什麼）
// ================================================
//   node tools/build-quest-treasure.mjs [TreasureDatas.csv]
//
// 客戶端的 QuestLands 每格只有 treasure_no，內容表只在伺服器上。來源是原版 Unlight 開源碼
// （open-unlight/Unlight，MIT）的 app/server/data/csv/ja/TreasureDatas.csv；沒給路徑就從
// GitHub 抓 master。寫到 packages/cdp-adapter/src/quest-treasure-data.ts，跑完再 npm run format。
//
// 2026-09-26 對過：客戶端 QuestLands 用到 675 種 treasure_no，只有 30223 不在表裡。
// 官方加了新任務、標註開始出現「沒標」的格子時再跑一次、再對一次。

import { readFileSync, writeFileSync } from "node:fs";

const URL =
  "https://raw.githubusercontent.com/open-unlight/Unlight/master/app/server/data/csv/ja/TreasureDatas.csv";
const OUT = new globalThis.URL(
  "../packages/cdp-adapter/src/quest-treasure-data.ts",
  import.meta.url,
);

const src = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : await (await fetch(URL)).text();

/** 夠用的 CSV：雙引號包的欄位裡可以有逗號，不處理跨行。 */
function parseLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const lines = src
  .replace(new RegExp("^" + String.fromCharCode(0xfeff)), "")
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "");
const head = parseLine(lines[0]);
const col = (name) => {
  const at = head.indexOf(name);
  if (at < 0) throw new Error(`CSV 少了欄位 ${name}`);
  return at;
};
const ID = col("id");
const ALLOC_TYPE = col("allocation_type");
const ALLOC_ID = col("allocation_id");
const TYPE = col("treasure_type");
const SLOT = col("slot_type");
const VALUE = col("value");

const rows = [];
for (const line of lines.slice(1)) {
  const f = parseLine(line);
  const id = Number(f[ID]);
  if (!Number.isInteger(id) || id <= 0) continue;
  const type = Number(f[TYPE]) || 0;
  const slot = Number(f[SLOT]) || 0;
  if (f[ALLOC_TYPE] === "1") {
    // 看牌組 COST 分配（原版 treasure_data.rb 的 get_treasure）：
    // 「1~55:50001,56~75:50002,76~999:50003」→ [[55, 50001], [75, 50002], [999, 50003]]
    const opts = f[ALLOC_ID].split(",").map((p) => {
      const [range, tno] = p.split(":");
      return [Number(range.split("~")[1]), Number(tno)];
    });
    if (opts.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) {
      console.error(`跳過看不懂的分配 ${id}: ${f[ALLOC_ID]}`);
      continue;
    }
    rows.push(`  ${id}: [${type}, 0, ${slot}, ${JSON.stringify(opts)}],`);
  } else {
    rows.push(`  ${id}: [${type}, ${Number(f[VALUE]) || 0}, ${slot}],`);
  }
}

const body = `/**
 * 任務格子的寶箱表：QuestLands.treasure_no → [treasure_type, value, slot_type, 分配?]
 * ============================================================================
 * **產生的檔案，別手改** —— \`node tools/build-quest-treasure.mjs\` 重產。
 *
 * 來源：原版 Unlight 開源碼 open-unlight/Unlight 的 app/server/data/csv/ja/TreasureDatas.csv
 * （Copyright(c)2019 CPA，MIT License：http://opensource.org/licenses/mit-license.php）。
 *
 * - treasure_type 跟客戶端 ItemType 同一套：1 角色卡、2 武器／事件卡、3 道具、5 Gem、6 OwnCard、7 獎勵遊戲
 * - value：角色卡／卡片／道具是 id，Gem 是數量
 * - slot_type：卡片的種類（0 武器、2 事件）
 * - 第 4 格有的話是「看目前牌組 COST 分配」：[[COST 上限, treasure_no], ...]（區間從 1 連續往上），value 是 0
 */

export type QuestTreasureEntry =
  | readonly [type: number, value: number, slot: number]
  | readonly [type: number, value: number, slot: number, alloc: readonly (readonly [number, number])[]];

export const QUEST_TREASURE_TABLE: Readonly<Record<number, QuestTreasureEntry>> = {
${rows.join("\n")}
};
`;

writeFileSync(OUT, body);
console.log(`寫了 ${rows.length} 筆 → ${OUT.pathname}`);
