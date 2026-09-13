// 重抓渦的獎勵表（TL → 發現／參加／排名／擊破）
// ==============================================
//   node tools/scrape-raid-treasure.mjs [from] [to]      預設 1900–2400
//
// 來源是 ulgg.online 的 TL 查詢頁（伺服器端渲染，一個 TL 一個 GET）。
// 印出來的每一行是 `packages/cdp-adapter/src/raid-treasure.ts` 裡 ROWS 的格式，
// 整段貼回去就好。2026-09-13 掃 1–3000 只有 60 個 TL 有資料（2009–2013、
// 2076–2120、2157–2166）；官方換表時再跑一次。
//
// ⚠ 每個請求間隔 150ms，別把間隔拿掉 —— 那是別人的站。
// ⚠ ulgg 的道具名簡繁混用（「记忆的碎片」「魔之弹头」），這裡統一成 tcn，
//   對不上的名字會原樣留下並在 stderr 警告。

const [from = "1900", to = "2400"] = process.argv.slice(2);

const CANON = {
  记忆的碎片: "記憶的碎片",
  时间的碎片: "時間的碎片",
  灵魂的碎片: "靈魂的碎片",
  魔之弹头: "魔之彈頭",
  魔之手镯: "魔之手鐲",
  "记忆的书签(R1)": "記憶的書籤(R1)",
  铁币: "鐵幣",
  铜币: "銅幣",
  银币: "銀幣",
  金币: "金幣",
  白金币: "白金幣",
  "抽奖券(免费)": "抽獎券(免費)",
};
const MONS = {
  妖精: "mc1004",
  黑死獸: "mc1003_02",
  屠殺者: "mc1006_02",
  誘引之者: "mc1007_02",
  靈龜: "mc1008_02",
  龍鯰: "mc1012_02",
};

const strip = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

function parse(html) {
  const m = html.match(/<div class="raid-lookup__result">([\s\S]*?)<\/section>/);
  if (!m) return null;
  const block = m[1];
  const headline = strip(block.match(/raid-lookup__headline">([\s\S]*?)<\/div>/)[1]);
  const meta = strip(block.match(/raid-lookup__meta">([\s\S]*?)<\/div>/)[1]);
  const boxes = block
    .split('raid-lookup__reward-box">')
    .slice(1)
    .map((b) => {
      const title = strip(b.match(/reward-title">([\s\S]*?)<\/div>/)[1]);
      const items = [...b.matchAll(/reward-item">([\s\S]*?)<\/div>/g)].map((i) => strip(i[1]));
      return { title, items };
    });
  const hm = headline.match(/TL (\d+) · (.+)$/);
  const mm = meta.match(/星級 (\d+) ｜Map Level (\d+) ｜(.+)$/);
  return {
    tl: Number(hm[1]),
    boss: hm[2].trim().replace(/^M10 /, ""),
    rarity: Number(mm[1]),
    stage: Number(mm[2]),
    tier: mm[3].trim(),
    rewards: Object.fromEntries(boxes.map((b) => [b.title, b.items])),
  };
}

function encode(items) {
  return items
    .map((it) => {
      const m = it.match(/^(.+?) ×(\d+)(?:（排名 (\d+)–(\d+)）)?$/);
      if (!m) throw new Error(`看不懂的獎勵：${it}`);
      const name = CANON[m[1]] ?? m[1];
      if (/[一-鿿]/.test(name) && !CANON[m[1]] && /[们个们钱]/.test(name)) {
        console.error(`⚠ 可能是簡體、沒對到 tcn：${name}`);
      }
      return `${name}×${m[2]}${m[3] ? `@${m[3]}-${m[4]}` : ""}`;
    })
    .join(",");
}

for (let tl = Number(from); tl <= Number(to); tl++) {
  const res = await fetch(`https://ulgg.online/pages/raid_observer.php?raid_lookup=${tl}`);
  const rec = parse(await res.text());
  if (rec) {
    const mons = MONS[rec.boss];
    if (!mons) console.error(`⚠ TL ${tl} 不認識的 BOSS：${rec.boss}`);
    if (rec.tier !== "渦II/III") console.error(`⚠ TL ${tl} 不是渦II/III：${rec.tier}`);
    const r = rec.rewards;
    console.log(
      `  [${tl}, "${mons ?? rec.boss}", ${rec.rarity}, ${rec.stage}, "${encode(r["發現獎勵"] ?? [])}", "${encode(r["參加獎勵"] ?? [])}", "${encode(r["排名獎勵"] ?? [])}", "${encode(r["擊破獎勵"] ?? [])}"],`,
    );
  }
  await new Promise((r) => setTimeout(r, 150));
}
