#!/usr/bin/env python3
"""
ULR Companion 插件互傳：查渦的 stage（碎片）與 BOSS 狀態
======================================================

給 ulgg 用的查詢範例。只用標準函式庫（Python 3.8+）。

資料是怎麼來的
--------------
開著 ULR Companion 的玩家在渦房時，托盤每 30 秒把自己渦清單上的渦傳到插件的雲端看板：

- stage：自己發現渦時伺服器送的 raid_title.raid_stage、或打渦時戰鬥設定的
  room_config.stage。發現者一進渦房（新渦出現在清單上）30 秒內就會傳上來
- BOSS 狀態：打渦**開場那一刻** BOSS 身上的狀態（戰鬥裡 get_chara_opponent 回的
  state）。改版後渦清單上沒有 state，只有開打時看得到

怎麼查
------
看板上沒有渦碼也沒有名字，只有雜湊當鍵。鍵是：

    SHA-256(f"{種類}\\n{發現者}\\n{到期時刻ms}") 的前 16 個十六進位字元

種類是 "stage" 或 "states"；發現者與到期時刻就是 observed_raids 的 founder 與
expires_at（毫秒整數，跟遊戲 db_raid 的 limit 同一個數）。拿鍵去
GET https://ulr-link.lldavuull.workers.dev/raids?keys=k1,k2,...（一次最多 24 把）。

**只能主動查（輪詢），沒有推播。** 看板每次都回當下的資料、不快取、不需要帳號；
建議跟 ulgg 現在一樣 30 秒查一次、只查還沒結束的渦。查不到＝還沒有插件玩家傳過。

用法
----
    python ulr_raid_share.py --selftest
    python ulr_raid_share.py 燈皇 1790337757565          # 查一個渦
    python ulr_raid_share.py --ulgg                      # 拿 ulgg 現在觀測中的渦全部查一次

程式裡用 lookup(...)：

    from ulr_raid_share import lookup
    got = lookup([("燈皇", 1790337757565), ("dreamscape", 1790337063442)])
    for (founder, expires_at), info in got.items():
        print(founder, info["fragment"], info["states"])
"""

import hashlib
import json
import sys
import urllib.request
from typing import Dict, Iterable, List, Optional, Tuple

BOARD_URL = "https://ulr-link.lldavuull.workers.dev/raids"
ULGG_OBSERVED_URL = "https://ulgg.online/api/observed_raids.php"
MAX_KEYS_PER_GET = 24
TIMEOUT_S = 10
USER_AGENT = "ulr-raid-share-client/1"

# (rarity == 6 ? stage + 1 : stage) % 5 → 碎片。2026-09-25 十四場結算全部符合。
FRAGMENTS = ["死亡", "記憶", "時間", "靈魂", "生命"]


def share_key(kind: str, founder: str, expires_at: int) -> str:
    """看板的鍵。kind 是 "stage" 或 "states"；expires_at 是毫秒整數。"""
    raw = f"{kind}\n{founder}\n{int(expires_at)}".strip()
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def fragment(rarity: Optional[int], stage: Optional[int]) -> Optional[str]:
    """stage → 排名獎勵的碎片種類。★6 是 stage+1。缺資料回 None。"""
    if rarity is None or stage is None:
        return None
    return FRAGMENTS[((stage + 1 if rarity == 6 else stage) % 5 + 5) % 5]


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        return json.loads(res.read().decode("utf-8"))


def lookup(
    raids: Iterable[Tuple[str, int]], board_url: str = BOARD_URL
) -> Dict[Tuple[str, int], dict]:
    """
    查一批渦。raids 是 (發現者, 到期時刻ms) 的清單。
    回傳 {(發現者, 到期時刻): 資料}，查不到的渦不會出現。資料：

        stage            int 或 None
        rarity           int 或 None（上傳者清單上的 ★）
        fragment         "記憶" 等，或 None
        stage_seen_at    看板收到 stage 的時刻（ms）
        states           [{"type": "scare", "until": ms 或 None, "count": int 或 None}]
                         type 是遊戲的狀態代碼（跟 observed_raids 的 state_raw.type 同一套）；
                         until 是到期時刻，count 是層數／回合數。已過期的看板會先拿掉
        states_seen_at   看板收到這份狀態的時刻（ms）≈ 某個玩家開打的時刻；None＝沒人傳過

    ⚠ states 是「某人最近一次開打時」看到的，不是即時的；新狀態要等下一個人開打才會更新。
    """
    wanted = {}
    for founder, expires_at in raids:
        k = (founder, int(expires_at))
        wanted[share_key("stage", *k)] = ("stage", k)
        wanted[share_key("states", *k)] = ("states", k)

    found: Dict[Tuple[str, int], dict] = {}
    keys = list(wanted)
    for i in range(0, len(keys), MAX_KEYS_PER_GET):
        chunk = keys[i : i + MAX_KEYS_PER_GET]
        body = _get_json(f"{board_url}?keys={','.join(chunk)}")
        for raw in body.get("raids", []):
            hit = wanted.get(raw.get("key"))
            if hit is None:
                continue
            kind, k = hit
            info = found.setdefault(
                k,
                {
                    "stage": None,
                    "rarity": None,
                    "fragment": None,
                    "stage_seen_at": None,
                    "states": [],
                    "states_seen_at": None,
                },
            )
            if kind == "stage":
                info["stage"] = raw.get("stage")
                info["rarity"] = raw.get("rarity")
                info["fragment"] = fragment(info["rarity"], info["stage"])
                info["stage_seen_at"] = raw.get("seenAt")
            else:
                info["states"] = raw.get("states") or []
                info["states_seen_at"] = raw.get("seenAt")
    return found


def lookup_ulgg_active() -> List[dict]:
    """示範：拿 ulgg 現在觀測中的渦（founder＋expires_at）全部查一次。"""
    data = _get_json(ULGG_OBSERVED_URL)
    rows = [
        r
        for r in data.get("raids", [])
        if r.get("status") == "active" and r.get("founder") and r.get("expires_at")
    ]
    got = lookup((r["founder"], r["expires_at"]) for r in rows)
    out = []
    for r in rows:
        info = got.get((r["founder"], int(r["expires_at"])))
        out.append(
            {
                "raid_id": r.get("raid_id"),
                "boss": r.get("boss"),
                "founder": r["founder"],
                "expires_at": r["expires_at"],
                "ulgg_stage_id": r.get("stage_id"),
                "shared": info,
            }
        )
    return out


def self_test() -> None:
    """鍵要跟插件（TypeScript 的 raidRowShareKey）算出來的一模一樣。"""
    vectors = [
        ("stage", "燈皇", 1790337757565, "aacda4c63eeae29c"),
        ("states", "燈皇", 1790337757565, "5a2594021b7b3977"),
        ("stage", "Owlic", 1790328501134, "ec4972be39ec3b89"),
    ]
    for kind, founder, limit, want in vectors:
        got = share_key(kind, founder, limit)
        assert got == want, f"{kind}/{founder}/{limit}: {got} != {want}"
    assert fragment(1, 3) == "靈魂" and fragment(6, 3) == "生命" and fragment(1, 5) == "死亡"
    print("ok")


def main(argv: List[str]) -> int:
    if argv[:1] == ["--selftest"]:
        self_test()
        return 0
    if argv[:1] == ["--ulgg"]:
        print(json.dumps(lookup_ulgg_active(), ensure_ascii=False, indent=2))
        return 0
    if len(argv) == 2:
        got = lookup([(argv[0], int(argv[1]))])
        print(json.dumps(next(iter(got.values()), None), ensure_ascii=False, indent=2))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
