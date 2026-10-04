"""舊版（2026-09-23 改版前）武器／事件卡索引 → 新版卡片 id
================================================================
2026-09-23 改版把客戶端的卡片資料整個換掉：

    舊  avatar_item.weapon[索引]   event_info.frames[索引]    ← 規則鍵 wp001／ev091、牌組庫都用這個索引
    新  WeaponCards[] 帶 id        EventCards[] 帶 id          ← 牌組（deck_update）與 COST 都用 id

而且**順序重排過**：舊 weapon[1] 是「勇者短劍」，新 WeaponCards[1] 是「妖魔彈藥」(id 2)。
所以不能拿索引 +1 當 id，要逐張對。這支產生那張對照表。

輸入
----
1. 改版前的清單：E:\\unlight_crawler\\steam\\data\\cost_weapon.csv / cost_event.csv（idx + 名字 + 數值）
2. 改版後的卡表：對著跑著的遊戲 dump 出來的 JSON（{weapons:[{id,name,info,cost,atk,def,chara}], events:[...]}）

    npx tsx probe-eval.tmp.mts <埠> <dumpcards.js>  > cards-new.json   （dumpcards.js 見檔尾）
    python scripts/build-legacy-card-ids.py cards-new.json

輸出 packages/rule-schema/src/legacy-card-ids.ts。

對法
----
- 先用名字：舊的中文名，沒有就用日文名（改版後有些卡的「中文名」就是日文原文）。
- 名字唯一就定案；同名的（5 張「Hp恢復」）再用說明文字，還分不開就照兩邊的出現順序。
- 名字對不到的只有幾張沒名字的角色專屬武器，手動指定在 MANUAL，每一筆都寫了依據。
- 最後驗：舊索引全部有對到、新 id 沒有被兩個舊索引搶、COST 相同（改名的佔位卡除外）。
  任何一條不過就不寫檔。
"""

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

CRAWLER = Path(r"E:\unlight_crawler\steam\data")
OUT = Path(__file__).resolve().parent.parent / "packages" / "rule-schema" / "src" / "legacy-card-ids.ts"

# 舊索引 → 新 id。名字對不到的才放這裡。2026-09-24 對著改版後的客戶端核對：
MANUAL_WEAPON = {
    198: 212,  # アリステリアの武器1：cc061 專屬、近 ATK+3 DEF+2，新版 212 同角色同數值、沒有名字
    201: 215,  # ヒューゴの武器1：cc062 專屬、近 ATK+3 DEF+2，新版 215 同上
    207: 218,  # アリアーヌの武器1：cc063、ATK-2 DEF+4，新版 218 同數值
    208: 220,  # アリアーヌの武器3：cc063、「ATK+1,DEF+2。」，新版 220 說明一字不差
    # 舊版 cc064 有 武器1(210)／斯托爾茲玫瑰(212)／武器2(211)；改版後佔位的「武器2」改名成
    # 「武器3」—— 數值一模一樣（COST 1、兩種距離 ATK+1 DEF+2、說明「(未定)」）。
    # ⚠ 不是 222：222 是斯托爾茲玫瑰，舊版本來就有（舊 212）。
    211: 223,  # グレゴールの武器2 → グレゴールの武器3
    214: 226,  # レタの武器2 → レタの武器3（同上，舊 215 是斬鱗 = 新 225）
}
# 目前沒有 COST 變動的卡。有的話列在這裡並寫理由。
COST_CHANGE_OK_WEAPON: set = set()


def load_new(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    return d["weapons"], d["events"]


def match(old_rows, new_cards, names_of, info_of, manual):
    by_name = defaultdict(list)
    for c in new_cards:
        by_name[c["name"]].append(c)
    out = dict(manual)
    # 同名的一組一組處理，照出現順序配對。
    groups = defaultdict(list)
    for r in old_rows:
        idx = int(r["idx"])
        if idx in out:
            continue
        for name in names_of(r):
            if name and name in by_name:
                groups[name].append(r)
                break
        else:
            raise SystemExit(f"對不到：舊索引 {idx} {names_of(r)}")
    for name, olds in groups.items():
        news = by_name[name]
        if len(olds) == 1 and len(news) == 1:
            out[int(olds[0]["idx"])] = news[0]["id"]
            continue
        # 同名：先用說明文字分組，每組內照順序。
        by_info_old, by_info_new = defaultdict(list), defaultdict(list)
        for r in olds:
            by_info_old[info_of(r)].append(r)
        for c in news:
            by_info_new[c.get("info", "")].append(c)
        for info, rs in by_info_old.items():
            cs = by_info_new.get(info, [])
            if len(cs) != len(rs):
                raise SystemExit(f"同名 {name} 說明 {info!r} 兩邊張數不同：舊 {len(rs)} 新 {len(cs)}")
            for r, c in zip(sorted(rs, key=lambda r: int(r["idx"])), sorted(cs, key=lambda c: c["id"])):
                out[int(r["idx"])] = c["id"]
    return out


def verify(kind, mapping, old_rows, new_cards, cost_ok=()):
    n_old = len(old_rows)
    if sorted(mapping) != list(range(n_old)):
        raise SystemExit(f"{kind}：舊索引沒有全部對到（{n_old} 張，對到 {len(mapping)}）")
    ids = list(mapping.values())
    if len(set(ids)) != len(ids):
        raise SystemExit(f"{kind}：有新 id 被兩個舊索引對到")
    new_by_id = {c["id"]: c for c in new_cards}
    for idx, nid in mapping.items():
        if nid not in new_by_id:
            raise SystemExit(f"{kind}：新 id {nid} 不存在")
        old_cost = int(old_rows[idx]["cost"])
        if idx not in cost_ok and old_cost != int(new_by_id[nid]["cost"]):
            raise SystemExit(f"{kind}：舊 {idx} COST {old_cost} ≠ 新 {nid} COST {new_by_id[nid]['cost']}")
    unused = sorted(set(new_by_id) - set(ids))
    return unused


def main():
    weapons, events = load_new(sys.argv[1])
    old_w = list(csv.DictReader(open(CRAWLER / "cost_weapon.csv", encoding="utf-8-sig")))
    old_e = list(csv.DictReader(open(CRAWLER / "cost_event.csv", encoding="utf-8-sig")))
    for rows in (old_w, old_e):
        if [int(r["idx"]) for r in rows] != list(range(len(rows))):
            raise SystemExit("舊清單的 idx 不是 0..n-1 連號")

    wmap = match(old_w, weapons, lambda r: [r["name_tcn"], r["name_ja"]],
                 lambda r: r["info_tcn"], MANUAL_WEAPON)
    emap = match(old_e, events, lambda r: [r["name"].split(" / ")[-1].strip(), r["name"].split(" / ")[0].strip()],
                 lambda r: r["info_tcn"], {})
    w_new_only = verify("武器", wmap, old_w, weapons, COST_CHANGE_OK_WEAPON)
    e_new_only = verify("事件卡", emap, old_e, events)

    def arr(m):
        vals = [str(m[i]) for i in range(len(m))]
        lines, line = [], "  "
        for v in vals:
            if len(line) + len(v) + 2 > 98:
                lines.append(line.rstrip())
                line = "  "
            line += v + ", "
        lines.append(line.rstrip())
        return "\n".join(lines)

    OUT.write_text(f"""/**
 * 舊版（2026-09-23 改版前）武器／事件卡索引 → 新版卡片 id
 * ========================================================
 * **這個檔是產生的**：`python scripts/build-legacy-card-ids.py cards-new.json`，
 * 對法與每一筆手動指定的依據在那支腳本的檔頭。不要手改。
 *
 * 規則鍵 `wp001`／`ev091` 與舊牌組庫存的都是**舊索引**；改版後客戶端只認 id，
 * 而且順序重排過（舊 weapon[1] 是勇者短劍，新 WeaponCards[1] 是妖魔彈藥）。
 *
 * 陣列位置 = 舊索引，值 = 新 id。改版後才新增的卡沒有舊索引，不在表裡
 * （武器 {len(w_new_only)} 張、事件卡 {len(e_new_only)} 張）。
 */

/** `avatar_item.weapon[i]`（舊）→ `WeaponCards[].id`（新）。{len(wmap)} 筆。 */
export const LEGACY_WEAPON_IDS: readonly number[] = [
{arr(wmap)}
];

/** `event_info.frames[i]`（舊）→ `EventCards[].id`（新）。{len(emap)} 筆。 */
export const LEGACY_EVENT_IDS: readonly number[] = [
{arr(emap)}
];
""", encoding="utf-8", newline="\n")
    print(f"武器 {len(wmap)} 筆、事件卡 {len(emap)} 筆 → {OUT}")
    print(f"改版後才有的：武器 {w_new_only}，事件卡 {e_new_only}")


if __name__ == "__main__":
    main()

# dumpcards.js（丟進 probe-eval 跑）：
# (function () {
#   var J = game.cache.json;
#   return JSON.stringify({
#     weapons: J.get("WeaponCards").map(function (w) { return { id: w.id, name: w.name_tcn, info: w.info_tcn, cost: w.cost, atk: w.atk, def: w.def, chara: w.chara }; }),
#     events: J.get("EventCards").map(function (e) { return { id: e.id, name: e.name_tcn, info: e.info_tcn, cost: e.cost }; })
#   });
# })()
