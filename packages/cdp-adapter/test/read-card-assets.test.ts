/**
 * 四張 COST 表讀取的解析測試
 *
 * 這些資料會直接變成規則檔的內容並進 contentHash，所以解析器的責任是
 * **壞掉要吵，空位要安靜** —— 兩者搞反都會產生一份對不上客戶端的規則。
 *
 * ⚠ 兩種形狀的「安靜」界線**不一樣**，那是這一份最重要的區別：
 * 具名的表（角色／怪物）可以用「沒有 filename」認出保留空位；索引型的表
 * （裝備／事件卡）沒有那個訊號，少一筆就是索引整個往前偏。
 */

import { describe, expect, it } from "vitest";
import {
  CcAssetReadError,
  parseCharacterAssets,
  parseIndexedCards,
  toCostTable,
} from "@ulr/cdp-adapter";

const card = (i: number, filename: string, cost: number) =>
  JSON.stringify({
    charaIndex: i,
    filename,
    chara: filename.split("_")[0],
    level: 1,
    rarity: 5,
    cost,
    hp: 8,
    atk: 4,
    def: 5,
  });

const wrap = (rows: string[]) => `{"rows":[${rows.join(",")}]}`;

describe("parseCharacterAssets", () => {
  it("讀出卡片並保留原始 charaIndex", () => {
    const raw = wrap([card(0, "cc001_01", 8), card(1, "cc001_02", 12)]);
    const { assets, totalFrames, placeholders } = parseCharacterAssets(raw);

    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ charaIndex: 0, filename: "cc001_01", cost: 8 });
    expect(totalFrames).toBe(2);
    expect(placeholders).toBe(0);
  });

  it("略過沒有 filename 的保留空位，但把數量報出來", () => {
    // 2026-08-15 的實測形狀：781 格裡有 81 格是空的
    const raw = wrap([card(0, "cc001_01", 8), "{}", '{"charaIndex":2}', card(3, "cc001_02", 12)]);
    const { assets, totalFrames, placeholders } = parseCharacterAssets(raw);

    expect(assets.map((a) => a.filename)).toEqual(["cc001_01", "cc001_02"]);
    expect(assets[1]!.charaIndex).toBe(3); // ⚠ 略過空位不能重編號，封包用的就是這個索引
    expect(totalFrames).toBe(4);
    expect(placeholders).toBe(2);
  });

  it("全欄位歸零的哨兵也算空位（filename 是空字串）", () => {
    const sentinel = '{"charaIndex":1,"filename":"","chara":"","level":0,"rarity":0,"cost":0}';
    const { assets, placeholders } = parseCharacterAssets(wrap([card(0, "cc001_01", 8), sentinel]));
    expect(assets).toHaveLength(1);
    expect(placeholders).toBe(1);
  });

  it("⚠ 有 filename 卻讀不到 cost 是硬錯誤，不能默默跳過", () => {
    // 跳過的話那張卡會在規則裡缺席，然後被算成 UNKNOWN_COST 99。
    const broken = '{"charaIndex":1,"filename":"cc001_02"}';
    expect(() => parseCharacterAssets(wrap([broken]))).toThrow(CcAssetReadError);
    expect(() => parseCharacterAssets(wrap([broken]))).toThrow(/cc001_02.*cost/);
  });

  it("filename 撞號要報錯 —— 它是規則的唯一鍵", () => {
    const raw = wrap([card(0, "cc001_01", 8), card(1, "cc001_01", 12)]);
    expect(() => parseCharacterAssets(raw)).toThrow(/重複/);
  });

  it("頁面回傳 error 就照原文丟出來", () => {
    const raw = '{"error":"Phaser 快取裡沒有 cc_asset"}';
    expect(() => parseCharacterAssets(raw)).toThrow(/沒有 cc_asset/);
  });

  it("一張卡都沒有時報錯，不回空表", () => {
    expect(() => parseCharacterAssets(wrap(["{}", "{}"]))).toThrow(/一張卡都沒有/);
  });

  it("不是 JSON 就報錯，並帶上開頭方便查", () => {
    expect(() => parseCharacterAssets("<html>502</html>")).toThrow(/不是 JSON/);
  });
});

describe("toCostTable", () => {
  it("攤成 filename → cost，鍵照字典序", () => {
    const { assets } = parseCharacterAssets(
      wrap([card(0, "cc002_01", 8), card(1, "cc001_01", 9), card(2, "cc001_r01", 19)]),
    );
    const table = toCostTable(assets);

    expect(Object.keys(table)).toEqual(["cc001_01", "cc001_r01", "cc002_01"]);
    expect(table).toEqual({ cc001_01: 9, cc001_r01: 19, cc002_01: 8 });
  });

  it("L4 與 R4 是不同的鍵 —— 這正是不能用 chara+level 當鍵的理由", () => {
    const { assets } = parseCharacterAssets(
      wrap([card(0, "cc078_04", 19), card(1, "cc078_r04", 21)]),
    );
    expect(toCostTable(assets)).toEqual({ cc078_04: 19, cc078_r04: 21 });
  });
});

describe("parseIndexedCards（裝備與事件卡）", () => {
  const row = (index: number, cost: number, name = `卡${index}`, chara?: string) =>
    JSON.stringify({ index, cost, name, ...(chara === undefined ? {} : { chara }) });
  const box = (rows: string[], total = rows.length) =>
    `{"rows":[${rows.join(",")}],"total":${total}}`;

  it("讀出索引與 cost —— 索引就是規則鍵的來源", () => {
    const { cards, total } = parseIndexedCards(box([row(0, 0, "妖魔短劍"), row(1, 1, "勇者短劍")]));
    expect(cards).toEqual([
      { index: 0, cost: 0, name: "妖魔短劍", chara: null },
      { index: 1, cost: 1, name: "勇者短劍", chara: null },
    ]);
    expect(total).toBe(2);
  });

  it("專武帶著角色限制 —— 那是「這件裝備屬於誰」的唯一來源", () => {
    // 實測 238 件裡有 212 件綁角色。沒綁的是 null，不是空字串 ——
    // 空字串會被當成「有一位叫做空字串的角色」而多生一個空的分組。
    const { cards } = parseIndexedCards(
      box([row(15, 2, "永恆之棘", "cc001"), row(0, 0, "妖魔短劍"), row(1, 1, "無主", "")]),
    );
    expect(cards.map((c) => c.chara)).toEqual(["cc001", null, null]);
  });

  it("⚠ 這裡沒有「保留空位」—— 讀不到 cost 一律報錯", () => {
    // 具名的表可以略過沒有 filename 的空位；索引型的沒有那個訊號，
    // 少一筆就是索引往前偏，而偏掉的規則會把價格貼到隔壁那張卡上。
    expect(() => parseIndexedCards(box(['{"index":1}']))).toThrow(CcAssetReadError);
    expect(() => parseIndexedCards(box(['{"index":1}']))).toThrow(/cost/);
    expect(() => parseIndexedCards(box(["null"]))).toThrow(/不能有洞/);
  });

  it("cost 是 0 是合法的 —— 大多數行動卡就是 0", () => {
    expect(parseIndexedCards(box([row(0, 0)])).cards[0]?.cost).toBe(0);
  });

  it("頁面回傳 error 就照原文丟出來", () => {
    expect(() => parseIndexedCards('{"error":"Phaser 快取裡沒有 avatar_item"}')).toThrow(
      /沒有 avatar_item/,
    );
  });

  it("一張卡都沒有時報錯，不回空表", () => {
    expect(() => parseIndexedCards(box([]))).toThrow(/一張卡都沒有/);
  });

  it("不是 JSON 就報錯", () => {
    expect(() => parseIndexedCards("<html>502</html>")).toThrow(/不是 JSON/);
  });
});
