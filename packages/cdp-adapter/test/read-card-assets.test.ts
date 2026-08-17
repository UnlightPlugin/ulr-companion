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

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  CcAssetReadError,
  COST_PATCH_STATE_EXPRESSION,
  parseCharacterAssets,
  parseCostPatchState,
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
      { index: 0, cost: 0, name: "妖魔短劍", info: "", chara: null, slotType: null },
      { index: 1, cost: 1, name: "勇者短劍", info: "", chara: null, slotType: null },
    ]);
    expect(total).toBe(2);
  });

  it("事件卡帶回效果與插槽顏色 —— 五張「Hp恢復」只能靠這兩欄分辨", () => {
    // 2026-08-16 實測索引 88/89/90/92/93 全叫「Hp恢復」。名字一樣、回的點數
    // 不一樣、顏色也不一樣，光有 name 的話編輯器上就是五個一模一樣的格子。
    const { cards } = parseIndexedCards(
      box([
        JSON.stringify({ index: 88, cost: 1, name: "Hp恢復", info: "回復1點Hp", slotType: 2 }),
        JSON.stringify({ index: 90, cost: 2, name: "Hp恢復", info: "回復3點Hp", slotType: 2 }),
        JSON.stringify({ index: 92, cost: 1, name: "Hp恢復", info: "回復1點Hp", slotType: 0 }),
      ]),
    );
    expect(cards.map((c) => `${c.info}/${String(c.slotType)}`)).toEqual([
      "回復1點Hp/2",
      "回復3點Hp/2",
      "回復1點Hp/0",
    ]);
  });

  it("slotType 0 是紅色，不是「沒有顏色」", () => {
    // 0 是劍色。用 `||` 之類的寫法會把它變成 null，於是整族劍卡失去顏色。
    expect(
      parseIndexedCards(box([JSON.stringify({ index: 3, cost: 1, slotType: 0 })])).cards[0],
    ).toMatchObject({ slotType: 0 });
  });

  it("讀不到 info / slotType 不報錯 —— 它們只是給人看的", () => {
    // 對比上面那條「讀不到 cost 一律報錯」：cost 缺了會產生錯規則，這兩欄缺了
    // 只是那一格少一行說明。武器本來就沒有 slotType（實測 238 件全部沒有）。
    const { cards } = parseIndexedCards(box([row(0, 0, "妖魔短劍")]));
    expect(cards[0]).toMatchObject({ info: "", slotType: null });
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

/**
 * 「這一份文件的卡表被改寫過了嗎」
 *
 * ⚠ 這一組釘的是**判斷要問頁面，而且看不懂就當髒的**。誤判的兩種錯法不對稱：
 * 把髒的當乾淨會讓改過的價格變成名冊裡的「原價」（而且從此看起來完全正常，
 * 沒有任何錯誤訊息）；把乾淨的當髒只是多叫玩家重載一次遊戲。
 */
describe("卡表被改寫過了嗎", () => {
  it("沒有旗標＝這份文件乾淨", () => {
    expect(parseCostPatchState('{"patched":false,"applied":0}')).toEqual({
      patched: false,
      applied: 0,
    });
  });

  it("改寫過就是髒的，而且帶著張數（訊息要說得出改了幾張）", () => {
    expect(parseCostPatchState('{"patched":true,"applied":700}')).toEqual({
      patched: true,
      applied: 700,
    });
  });

  it("⚠ 讀不懂一律當成髒的 —— 不是 JSON", () => {
    expect(parseCostPatchState("<html>502</html>").patched).toBe(true);
  });

  it("⚠ 讀不懂一律當成髒的 —— 頁面回報 error", () => {
    expect(parseCostPatchState('{"error":"window 沒了"}').patched).toBe(true);
  });

  it("⚠ 讀不懂一律當成髒的 —— 少了 patched 欄位", () => {
    expect(parseCostPatchState('{"applied":3}').patched).toBe(true);
    expect(parseCostPatchState("null").patched).toBe(true);
  });

  it("applied 不是數字就當 0，但髒不髒照 patched 說的算", () => {
    expect(parseCostPatchState('{"patched":true,"applied":"很多"}')).toEqual({
      patched: true,
      applied: 0,
    });
  });
});

/**
 * 注入的旗標是 `patch-cost.ts` 維護的，所以表達式要跟它對得上 ——
 * 兩邊的名字寫錯一個字，這道閘就永遠說「乾淨」而且完全不會報錯。
 */
describe("問旗標的表達式", () => {
  it("問的是 patch-cost 掛在 window 上的那個名字", () => {
    expect(COST_PATCH_STATE_EXPRESSION).toContain("window.__ulrCostPatch");
  });

  it("在頁面上跑得動：沒旗標→乾淨、有旗標→照 applied 判", () => {
    // ⚠ 用 `node:vm` 而不是 `eval` / `new Function`（ESLint 擋掉，§12）。
    // 而且一定要**真的跑**，不能只驗字串長相 —— 旗標名字寫錯一個字的話，
    // 只比對字串的測試照樣是綠的，而那道閘會從此永遠說「乾淨」。
    const run = (flag: unknown) => {
      const sandbox = { window: flag === undefined ? {} : { __ulrCostPatch: flag } };
      const raw: unknown = new Script(COST_PATCH_STATE_EXPRESSION).runInNewContext(sandbox);
      return parseCostPatchState(raw as string);
    };
    expect(run(undefined)).toEqual({ patched: false, applied: 0 });
    expect(run({ installed: true, applied: 0 })).toEqual({ patched: false, applied: 0 });
    expect(run({ installed: true, applied: 700 })).toEqual({ patched: true, applied: 700 });
  });
});

/**
 * 升級圖（`next`）—— 判斷「官方出了這張卡沒」的依據
 *
 * ⚠ 這一組守的是 `hasUpgradeGraph` 的**方向**。它錯的話不會有錯誤訊息，只會
 * 讓編輯器把整份卡表藏光，而那看起來像插件壞了。
 */
describe("parseCharacterAssets：upgradeTarget / hasUpgradeGraph", () => {
  const withFlag = (i: number, filename: string, upgradeTarget: boolean) =>
    JSON.stringify({
      charaIndex: i,
      filename,
      chara: filename.split("_")[0],
      level: 1,
      rarity: 5,
      cost: 8,
      hp: 8,
      atk: 4,
      def: 5,
      upgradeTarget,
    });

  it("原封收下每張卡的 upgradeTarget", () => {
    const raw = `{"rows":[${withFlag(0, "cc001_01", false)},${withFlag(1, "cc001_02", true)}],"hasUpgradeGraph":true}`;
    const { assets, hasUpgradeGraph } = parseCharacterAssets(raw);
    expect(assets.map((a) => a.upgradeTarget)).toEqual([false, true]);
    expect(hasUpgradeGraph).toBe(true);
  });

  /**
   * ⚠⚠ 舊版的頁面腳本沒有這兩個欄位。那時 `upgradeTarget` 會全部讀成 false，
   * 而如果 `hasUpgradeGraph` 預設成 true，呼叫端就會把**每一張卡**判成
   * 「官方還沒出」。預設 false 的話那些 false 沒有人會採信。
   */
  it("⚠⚠ 沒有 hasUpgradeGraph 這個欄位時要當成 false，不是 true", () => {
    const { assets, hasUpgradeGraph } = parseCharacterAssets(wrap([card(0, "cc001_01", 8)]));
    expect(hasUpgradeGraph).toBe(false);
    // 沒有那個欄位的卡也一律 false —— 不猜
    expect(assets[0]!.upgradeTarget).toBe(false);
  });

  it("hasUpgradeGraph 不是布林就當 false", () => {
    const raw = `{"rows":[${withFlag(0, "cc001_01", true)}],"hasUpgradeGraph":"yes"}`;
    expect(parseCharacterAssets(raw).hasUpgradeGraph).toBe(false);
  });
});
