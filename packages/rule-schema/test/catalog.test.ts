/**
 * 卡片名冊
 *
 * 這一份釘的是編輯 COST 那一頁的**唯一存在理由**：
 * 規則檔裡是 `cc001_01`，玩家看到的必須是「艾伯李斯特 L1」。
 *
 * 所以測的重點有兩個：
 *   1. 版面（L1~L5 R1~R5、M1~M3、事件卡的族群）跟玩家指定的一致
 *   2. **任何情況下都不會把編號漏給玩家看**
 */

import { describe, expect, it } from "vitest";
import type { CatalogSource } from "@ulr/rule-schema";
import { buildCatalog, catalogSize, parseCatalog, slotLabel } from "@ulr/rule-schema";

const chara = (filename: string, cost: number) => ({
  filename,
  chara: filename.slice(0, 5),
  cost,
});
const mons = (filename: string, cost: number) => ({ filename, cost });

/** 一位角色的十張：L1~L5 R1~R5。 */
function tenOf(id: string, base = 8) {
  return [
    ...[1, 2, 3, 4, 5].map((n) => chara(`${id}_0${n}`, base + n)),
    ...[1, 2, 3, 4, 5].map((n) => chara(`${id}_r0${n}`, base + 10 + n)),
  ];
}

function src(over: Partial<CatalogSource> = {}): CatalogSource {
  return {
    gameVersion: "2026.08",
    characters: [...tenOf("cc002"), ...tenOf("cc001")],
    monsters: [mons("mc001_01", 9), mons("mc001_02", 10), mons("mc001_03", 13)],
    equipment: [{ index: 0, name: "妖魔短劍", cost: 0, chara: null }],
    eventCards: [{ index: 0, name: "劍1卡", cost: 0 }],
    profiles: {
      characters: { cc001: "艾伯李斯特", cc002: "艾依查庫" },
      monsters: { mc001_01: "森林侏儒" },
    },
    ...over,
  };
}

describe("slotLabel", () => {
  it("L / R / M 三種，數字照 filename 不照 level 欄位", () => {
    // ⚠ L4 與 R4 的 level 都是 4，只有 filename 分得開。用 level 當標籤的話
    // 覺醒卡會全部標成一般卡（open-questions 第 1 題）。
    expect(slotLabel("cc078_04")).toBe("L4");
    expect(slotLabel("cc078_r04")).toBe("R4");
    expect(slotLabel("mc001_02")).toBe("M2");
  });

  it("認不出來就原樣回傳，不會回空字串", () => {
    expect(slotLabel("怪東西")).toBe("怪東西");
  });
});

describe("角色：一位一排，L1~L5 R1~R5", () => {
  const cat = buildCatalog(src());

  it("每位剛好十格，順序是 L1…L5 R1…R5", () => {
    expect(cat.characters).toHaveLength(2);
    expect(cat.characters[0]!.cards.map((c) => c.slot)).toEqual([
      "L1",
      "L2",
      "L3",
      "L4",
      "L5",
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
    ]);
  });

  it("顯示的是名字，代號只留在 id 上", () => {
    expect(cat.characters.map((g) => g.name)).toEqual(["艾伯李斯特", "艾依查庫"]);
  });

  it("原價跟著每一格走 —— 編輯器要靠它畫「改過了」", () => {
    const abel = cat.characters[0]!;
    expect(abel.cards[0]).toMatchObject({ slot: "L1", baseCost: 9 });
    expect(abel.cards[5]).toMatchObject({ slot: "R1", baseCost: 19 });
  });
});

describe("怪物：M1~M3", () => {
  it("三格一組，名字取自 monsProfile（鍵是整個 filename）", () => {
    const cat = buildCatalog(src());
    expect(cat.monsters).toHaveLength(1);
    expect(cat.monsters[0]!.name).toBe("森林侏儒");
    expect(cat.monsters[0]!.cards.map((c) => c.slot)).toEqual(["M1", "M2", "M3"]);
  });

  it("⚠ 拿 `mc001` 去查 monsProfile 會查不到 —— 它的鍵是 `mc001_01`", () => {
    // 查錯層級的症狀是整排怪物都沒有名字，而不是報錯。
    const cat = buildCatalog(src({ profiles: { characters: {}, monsters: { mc001: "錯的鍵" } } }));
    expect(cat.monsters[0]!.name).not.toBe("錯的鍵");
  });
});

describe("裝備：照專武的主人分組", () => {
  const cat = buildCatalog(
    src({
      equipment: [
        { index: 0, name: "妖魔短劍", cost: 0, chara: null },
        { index: 15, name: "永恆之棘", cost: 2, chara: "cc001" },
        { index: 16, name: "王者之劍", cost: 2, chara: "cc001" },
        // 遊戲自己的佔位角色，charaProfile 裡沒有它
        { index: 99, name: "異化礦材", cost: 0, chara: "cc000" },
      ],
    }),
  );

  it("通用排最前面，專武照角色分組並用角色名當標題", () => {
    expect(cat.equipment.map((g) => g.name)).toEqual(["通用", "艾伯李斯特"]);
    expect(cat.equipment[1]!.charaId).toBe("cc001");
    expect(cat.equipment[1]!.items.map((i) => i.name)).toEqual(["永恆之棘", "王者之劍"]);
  });

  it("⚠ 查不到名字的擁有者併進「通用」，不會讓 cc000 這種代號漏到畫面上", () => {
    const generic = cat.equipment[0]!;
    expect(generic.charaId).toBeNull();
    expect(generic.items.map((i) => i.name)).toEqual(["妖魔短劍", "異化礦材"]);
    // 整份名冊裡不該有任何一個分組的標題是代號
    for (const g of cat.equipment) expect(g.name).not.toMatch(/^cc\d+$/);
  });

  it("規則鍵是 wp + 補零索引", () => {
    expect(cat.equipment[1]!.items.map((i) => i.key)).toEqual(["wp015", "wp016"]);
  });
});

describe("事件卡：族群分塊，順序不動", () => {
  /** 照實測的形狀縮小版：七個大族 + 一堆零星的尾巴。 */
  const events = [
    ...Array.from({ length: 9 }, (_, i) => ({ index: i, name: `劍${i + 1}卡`, cost: 0 })),
    ...Array.from({ length: 5 }, (_, i) => ({ index: 9 + i, name: `槍${i + 1}卡`, cost: 0 })),
    { index: 14, name: "Hp恢復", cost: 1 },
    { index: 15, name: "聖水", cost: 0 },
    { index: 16, name: "聖杯卡", cost: 0 },
    { index: 17, name: "病毒", cost: 0 },
    // 尾段又冒出一張劍系的複合卡 —— 不能因此在後面生出第二個「劍」區塊
    { index: 18, name: "劍1·槍1卡", cost: 0 },
    { index: 19, name: "劍5·槍5卡", cost: 0 },
    { index: 20, name: "劍1·盾1卡", cost: 0 },
    { index: 21, name: "劍1·移動1卡", cost: 0 },
  ];
  const cat = buildCatalog(src({ eventCards: events }));

  it("夠多張的族自成一塊，其餘全部進「其他」", () => {
    expect(cat.eventCards.map((g) => `${g.name}:${g.items.length}`)).toEqual([
      "劍:9",
      "槍:5",
      "其他:8",
    ]);
  });

  it("⚠ 尾段不會生出第二個同名區塊 —— 兩塊「劍」隔得老遠會像 bug", () => {
    expect(cat.eventCards.filter((g) => g.name === "劍")).toHaveLength(1);
  });

  it("⚠ 順序完全照客戶端的索引，一張都沒重排", () => {
    const flat = cat.eventCards.flatMap((g) => g.items.map((i) => i.key));
    expect(flat).toEqual(events.map((e) => `ev${String(e.index).padStart(3, "0")}`));
  });

  it("複合卡的族群看第一個數字前那一段（`劍3·槍1卡` → 劍）", () => {
    expect(cat.eventCards[0]!.items[0]!.name).toBe("劍1卡");
  });
});

describe("名冊本身", () => {
  it("catalogSize 數的是卡片不是分組", () => {
    expect(catalogSize(buildCatalog(src()))).toEqual({
      characters: 20,
      monsters: 3,
      equipment: 1,
      eventCards: 1,
    });
  });

  it("⚠ 壞掉的快取一律 null，不拋例外 —— 那時該重讀，不是讓插件開不起來", () => {
    expect(parseCatalog(null)).toBeNull();
    expect(parseCatalog({ version: 1, characters: [] })).toBeNull();
    expect(parseCatalog({ ...buildCatalog(src()), version: 999 })).toBeNull();
    expect(parseCatalog({ ...buildCatalog(src()), characters: [] })).toBeNull();
  });

  it("自己產的名冊過得了自己的檢查（存檔 → 讀回來要是同一份）", () => {
    const cat = buildCatalog(src());
    const round = parseCatalog(JSON.parse(JSON.stringify(cat)));
    expect(round).toEqual(cat);
  });
});
