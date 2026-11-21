// 公牌表產生器：把 Moon 的「公牌記錄」轉成插件內建的 packages/kifu/src/public-decks.ts
//
//   node tools/build-public-decks.mjs [公牌記錄資料夾]
//
// 預設資料夾是 %USERPROFILE%\Desktop\Unlight\code\Moon\公牌記錄（2026-10-09 錄的 14 個地點）。
// 只取地點、地點名、張數與每張的牌面；原始檔裡的房號與事件流一律不帶進來。
//
// 牌面原檔是「槍1/劍1」（上半/下半），轉成 [上半種類, 數字, 下半種類, 數字]。

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? join(homedir(), "Desktop", "Unlight", "code", "Moon", "公牌記錄");
const SUIT = { 劍: "swd", 槍: "gun", 防: "shi", 移: "mov", 特: "spe" };

function half(s) {
  const m = /^(劍|槍|防|移|特)(\d+)$/.exec(s);
  if (!m) throw new Error(`看不懂的半邊：${s}`);
  return [SUIT[m[1]], Number(m[2])];
}

const progress = JSON.parse(readFileSync(join(dir, "進度.json"), "utf8"));
const out = {};
for (const [stage, file] of Object.entries(progress.完成).sort()) {
  const j = JSON.parse(readFileSync(join(dir, file), "utf8"));
  if (j.完整 !== true) throw new Error(`${stage} 不完整`);
  const n = j.開場公牌;
  const cards = [];
  for (let i = 0; i < n; i++) {
    const label = j.牌[String(i)];
    if (typeof label !== "string") throw new Error(`${stage} 缺 index ${i}`);
    const [a, b] = label.split("/");
    cards.push([...half(a), ...half(b)]);
  }
  out[stage] = { name: j.地點名, cards };
}

const body = Object.entries(out)
  .map(
    ([s, d]) =>
      `  "${s}": {\n    name: ${JSON.stringify(d.name)},\n    cards: [\n${d.cards.map((c) => `      ${JSON.stringify(c)},`).join("\n")}\n    ],\n  },`,
  )
  .join("\n");

writeFileSync(
  new URL("../packages/kifu/src/public-decks.ts", import.meta.url),
  `/**
 * 每個地點的公牌（行動卡共用牌堆）—— **產生出來的檔，別手改**
 * ============================================================
 * \`node tools/build-public-decks.mjs\` 從 Moon 的「公牌記錄」產生（2026-10-09 兩個帳號對打、
 * 各記自己抽到的牌，合起來就是整疊；見 Moon\\公牌記錄.py）。
 *
 * 每個地點一疊固定的牌，伺服器推的每張行動卡都帶 \`index\`（0～N−1），同一地點同一個 index
 * 永遠是同一張。陣列索引就是那個 index；每張是 \`[上半種類, 數字, 下半種類, 數字]\`。
 *
 * 改版可能換牌：記牌那邊拿實際抽到的牌跟這張表比對，對不上就不用這張表（見 counter.ts）。
 */

export type PublicCard = readonly [string, number, string, number];

export interface PublicDeck {
  name: string;
  cards: readonly PublicCard[];
}

export const PUBLIC_DECKS: Readonly<Record<string, PublicDeck>> = {
${body}
};
`,
);
console.log(
  `寫好了：${Object.keys(out).length} 個地點`,
  Object.entries(out)
    .map(([s, d]) => `${s}=${d.cards.length}`)
    .join(" "),
);
