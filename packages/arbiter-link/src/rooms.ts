/**
 * 中間人的房間狀態機（WP-15）
 * ==============================
 * `broker.ts` 是 socket 的膠水，**規則全在這裡**，而這裡沒有任何 I/O ——
 * 輸入是「誰送了什麼」，輸出是「該回誰什麼」。跟 `arbitration.ts` 同一個
 * 分工理由：這是會影響勝負的邏輯，必須能被完整測試。
 *
 * ⚠ **不要在 `broker.ts` 裡加判斷。** 一旦兩邊都能做決定，「中間人到底發不發
 * 那則 both-ready」就會有兩個答案，而錯的那個要到真的對戰時才看得到。
 */

import type { AgreedSettings, ClientMessage, LinkPrefs, ServerMessage } from "./protocol.js";
import { isCompatible, LINK_PROTOCOL_VERSION, negotiate, soloSettings } from "./protocol.js";

/** 一間房最多兩個人。第三個連進來會被回 `room-full`。 */
export const ROOM_CAPACITY = 2;

export interface Member {
  readonly id: string;
  room: string;
  prefs: LinkPrefs;
  /**
   * 這個人現在是不是「已準備」。
   *
   * ⚠ **這個欄位永遠不會被送給另一方。** 它只用來湊出 `both-ready`
   * 那個合成訊號 —— 見 `protocol.ts` 的紅線 1。
   */
  ready: boolean;
}

/** 要送出去的一則訊息。`to` 是成員 id。 */
export interface Outgoing {
  to: string;
  message: ServerMessage;
}

export class RoomRegistry {
  #members = new Map<string, Member>();

  get size(): number {
    return this.#members.size;
  }

  /** 某間房目前有誰。測試與診斷用。 */
  membersOf(room: string): readonly Member[] {
    return [...this.#members.values()].filter((m) => m.room === room);
  }

  #peer(member: Member): Member | null {
    for (const other of this.#members.values()) {
      if (other.id !== member.id && other.room === member.room) return other;
    }
    return null;
  }

  /** 這個人現在該看到的共同設定。沒配對到人就是單邊版本（秒數不縮短）。 */
  #settingsFor(member: Member): { paired: boolean; agreed: AgreedSettings } {
    const peer = this.#peer(member);
    if (peer === null) return { paired: false, agreed: soloSettings(member.prefs) };
    return { paired: true, agreed: negotiate(member.prefs, peer.prefs) };
  }

  /** 把房裡每個人的共同設定重發一次。設定變了、有人進出，都走這裡。 */
  #broadcastAgreed(room: string): Outgoing[] {
    return this.membersOf(room).map((m) => ({
      to: m.id,
      message: { t: "agreed", ...this.#settingsFor(m) } as ServerMessage,
    }));
  }

  /**
   * 有人連進來。回傳要送出去的訊息。
   *
   * 版本不合就**不收留他**，只回一則 `incompatible` —— 讓他退回單邊模式。
   * 收留一個講不同語言的人比拒絕他危險得多（見 `protocol.ts` 的版本註解）。
   */
  join(id: string, hello: Extract<ClientMessage, { t: "hello" }>): Outgoing[] {
    if (!isCompatible(hello.v)) {
      return [
        {
          to: id,
          message: {
            t: "incompatible",
            v: LINK_PROTOCOL_VERSION,
            reason: `對方協定版本 ${hello.v}，這裡是 ${LINK_PROTOCOL_VERSION}`,
          },
        },
      ];
    }
    if (this.membersOf(hello.room).length >= ROOM_CAPACITY) {
      return [{ to: id, message: { t: "room-full" } }];
    }

    const member: Member = { id, room: hello.room, prefs: hello.prefs, ready: false };
    this.#members.set(id, member);

    const mine = this.#settingsFor(member);
    const out: Outgoing[] = [
      { to: id, message: { t: "welcome", v: LINK_PROTOCOL_VERSION, ...mine } },
    ];
    // 對手的共同設定也變了（他從單邊變成配對），要告訴他。
    const peer = this.#peer(member);
    if (peer !== null) {
      out.push({ to: peer.id, message: { t: "agreed", ...this.#settingsFor(peer) } });
    }
    return out;
  }

  /** 有人斷線。 */
  leave(id: string): Outgoing[] {
    const member = this.#members.get(id);
    if (member === undefined) return [];
    const room = member.room;
    this.#members.delete(id);
    // 剩下的那個要立刻知道自己變回單邊 —— 否則他會繼續等一個不存在的
    // `both-ready`，一路壓到硬底線才送出。
    return this.#broadcastAgreed(room);
  }

  /**
   * 收到一則訊息。
   *
   * ⚠ **沒 join 過的一律忽略**（回空陣列）。之前的版本會順手建一個成員，
   * 結果版本不合被拒的那個人只要接著送 `ready` 就又混進來了。
   */
  handle(id: string, message: ClientMessage): Outgoing[] {
    const member = this.#members.get(id);
    if (member === undefined) return [];

    switch (message.t) {
      case "hello":
        // 重複的 hello：當成換設定，不要重新建成員（會丟掉 ready 狀態）。
        member.prefs = message.prefs;
        return this.#broadcastAgreed(member.room);

      case "prefs":
        member.prefs = message.prefs;
        return this.#broadcastAgreed(member.room);

      case "room": {
        if (member.room === message.room) return [];
        // ⚠ 換場一定要把 ready 清掉。留著的話新的一場一開始就可能湊成
        // `both-ready`，玩家還沒看清楚盤面就被送出去了。
        const from = member.room;
        member.room = message.room;
        member.ready = false;
        // 舊房的人變回單邊、新房的人變成配對 —— 兩邊都要重發。
        return [...this.#broadcastAgreed(from), ...this.#broadcastAgreed(member.room)];
      }

      case "ready": {
        member.ready = message.ready;
        const peer = this.#peer(member);
        // ⚠ 這裡是整個協定最敏感的三行。**只有兩邊都好才發，而且發的是
        // 合成訊號**；任何「順便告訴對方我好了」的改動都會破壞
        // `protocol.ts` 紅線 1。
        if (!member.ready || peer === null || !peer.ready) return [];
        // 只在雙方都同意開準備功能時才同步釋放。
        if (!negotiate(member.prefs, peer.prefs).readyEnabled) return [];

        // 發完就把兩邊的旗標收掉：這是**邊緣觸發**。不收的話下一則
        // `ready:true`（例如換場後的第一次）會立刻再湊成一次。
        member.ready = false;
        peer.ready = false;
        return [
          { to: member.id, message: { t: "both-ready" } },
          { to: peer.id, message: { t: "both-ready" } },
        ];
      }

      case "force-end": {
        const peer = this.#peer(member);
        if (peer === null) return [];
        // 只轉給對手 —— 送的人自己那邊的門檻本來就是自己算的，回給他是多餘的
        // 往返，而且會在 log 上長得像「對手也到了」。
        return [{ to: peer.id, message: { t: "force-end", reason: message.reason } }];
      }
    }
  }
}
