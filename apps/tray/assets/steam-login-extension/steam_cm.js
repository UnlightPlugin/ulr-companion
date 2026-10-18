// Minimal Steam CM client for the browser: just enough to sign in and create
// ISteamUser::GetAuthTicketForWebApi tickets.
//
// A port of src/steam_cm.py, which follows node-steam-user / steam-session
// (connection, logon, credential login) and SteamKit2's SteamAuthTicket (ticket
// layout). 64-bit protobuf values are BigInts.

const PROTOCOL_VERSION = 65580;
const PROTO_MASK = 0x80000000;
const JOBID_NONE = 0xffffffffffffffffn;
const TIMEOUT = 10_000;
const OPEN_TIMEOUT = 10_000;
// CMs to try before giving up, when one does not answer.
const CONNECT_ATTEMPTS = 3;
const LOGIN_TIMEOUT = 180_000;
const DEVICE_NAME = "unlight_extension";
const OS_TYPE_WIN11 = 20;
const PLATFORM_TYPE_STEAM_CLIENT = 1;

// Session header "ticket type": 2 is GetAuthSessionTicket, 5 is GetAuthTicketForWebApi.
const TICKET_TYPE_WEB_API = 5;
const SESSION_HEADER_SIZE = 24;
// GetTicketForWebApiResponse_t.m_rgubTicket is a fixed 2560-byte buffer and the
// Steam client hands out all of it, leftover memory included.
const WEB_API_TICKET_SIZE = 2560;

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const EMsg = {
  Multi: 1,
  ServiceMethodResponse: 147,
  ClientHeartBeat: 703,
  ClientLogOff: 706,
  ClientLogOnResponse: 751,
  ClientLoggedOff: 757,
  ClientGameConnectTokens: 779,
  ClientGetAppOwnershipTicket: 857,
  ClientGetAppOwnershipTicketResponse: 858,
  ClientGamesPlayedWithDataBlob: 5410,
  ClientEmailAddrInfo: 5456,
  ClientAuthList: 5432,
  ClientLogon: 5514,
  ClientRequestFreeLicense: 5572,
  ClientAuthListAck: 5575,
  ClientPlayingSessionState: 9600,
  ServiceMethodCallFromClientNonAuthed: 9804,
  ClientHello: 9805,
};

export const EResult = {
  OK: 1,
  Fail: 2,
  InvalidPassword: 5,
  AccessDenied: 15,
  Revoked: 26,
  Expired: 27,
  InvalidLoginAuthCode: 65,
  TwoFactorCodeMismatch: 88,
};

const EAuthSessionGuardType = {
  NONE: 1,
  EMAIL_CODE: 2,
  DEVICE_CODE: 3,
  DEVICE_CONFIRMATION: 4,
  EMAIL_CONFIRMATION: 5,
};

// LogonError results meaning the saved refresh token is no good and a new login is needed.
export const TOKEN_REJECTED = new Set([
  EResult.InvalidPassword,
  EResult.AccessDenied,
  EResult.Revoked,
  EResult.Expired,
]);

// Steam 的 EResult 錯誤碼 → 中文說明（只列登入、拿票證會碰到的）。
export const ERESULT_TEXT = {
  2: "一般失敗，Steam 沒說原因，通常稍後再試就好",
  3: "連不上 Steam",
  5: "帳號名稱或密碼錯誤（要填 Steam 帳號名稱，不是 Email；Steam 不會說是哪一個錯）",
  6: "這個帳號在別處登入了",
  8: "送給 Steam 的參數不對",
  10: "Steam 忙碌中，稍後再試",
  11: "狀態不對（通常重來一次就好）",
  15: "存取被拒：儲存的登入已失效，或帳號沒有這個遊戲",
  16: "Steam 逾時",
  17: "帳號被封鎖",
  18: "找不到這個帳號",
  20: "Steam 服務暫時無法使用（維護中？）",
  21: "還沒登入 Steam",
  25: "超過上限",
  26: "登入已被撤銷（在 Steam 移除了授權裝置，或改過密碼）",
  27: "登入已過期",
  29: "重複的請求",
  34: "這次登入被另一個登入取代了",
  35: "連線失敗",
  43: "帳號被停用",
  48: "請換一台 Steam 伺服器再試",
  50: "帳號已在別處登入",
  63: "登入被拒，需要 Steam Guard 驗證",
  65: "Steam Guard 驗證碼錯誤",
  66: "登入被拒：帳號沒有可收信的 Email",
  71: "Steam Guard 驗證碼過期",
  73: "帳號被鎖定",
  84: "嘗試太頻繁，被 Steam 限流（等 30 分鐘～1 小時再試，一直重試會延長）",
  85: "需要 Steam 手機令牌的兩步驟驗證",
  87: "登入太頻繁，被 Steam 暫時擋下，稍後再試",
  88: "手機令牌驗證碼錯誤",
};

export const explainEResult = (eresult) =>
  ERESULT_TEXT[eresult] ?? "未知的錯誤碼";

export class SteamError extends Error {
  constructor(eresult, message) {
    super(`${message}（錯誤碼 EResult ${eresult}：${explainEResult(eresult)}）`);
    this.name = new.target.name;
    this.eresult = eresult;
  }
}

/** Steam refused the logon itself, as opposed to a later request. */
export class LogonError extends SteamError {}

export class TimeoutError extends Error {
  name = "TimeoutError";
}

export class ConnectionError extends Error {
  name = "ConnectionError";
}

// 登入流程每一步失敗時顯示的中文。
const AUTH_METHOD_TEXT = {
  GetPasswordRSAPublicKey: "Steam 拒絕開始登入（拿不到加密金鑰）",
  BeginAuthSessionViaCredentials: "Steam 拒絕了帳號密碼",
  UpdateAuthSessionWithSteamGuardCode: "Steam Guard 驗證碼沒過",
  PollAuthSessionStatus: "等 Steam 核准登入時出錯",
  GenerateAccessTokenForApp: "更新 Steam 登入時出錯",
};

// --- Helpers ---

class Deferred {
  constructor() {
    this.done = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = (value) => {
        this.done = true;
        resolve(value);
      };
      this.reject = (error) => {
        this.done = true;
        reject(error);
      };
    });
    // Nobody may be waiting when the connection drops.
    this.promise.catch(() => {});
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function concat(parts) {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function view(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function uint32(value) {
  const out = new Uint8Array(4);
  view(out).setUint32(0, value, true);
  return out;
}

const toHex = (data) =>
  Array.from(new Uint8Array(data), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) {
    n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  }
  return n;
});

/** zlib.crc32 */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function gunzip(data) {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- Protobuf wire format ---

const VARINT = 0;
const FIXED64 = 1;
const BYTES = 2;
const FIXED32 = 5;

function varint(value) {
  let v = BigInt.asUintN(64, BigInt(value));
  const out = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function readVarint(data, offset) {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (offset >= data.length) {
      throw new RangeError("Truncated protobuf varint");
    }
    const byte = data[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) {
      return [value, offset];
    }
    shift += 7n;
  }
}

/**
 * Encode [field number, wire type, value] triples. null values are skipped, an
 * array repeats the field, and nested messages are passed pre-encoded.
 */
export function pb(...fields) {
  const parts = [];
  for (const [number, wireType, value] of fields) {
    if (value === null || value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      parts.push(varint((number << 3) | wireType));
      if (wireType === VARINT) {
        parts.push(varint(item));
      } else if (wireType === FIXED64) {
        const out = new Uint8Array(8);
        view(out).setBigUint64(0, BigInt.asUintN(64, BigInt(item)), true);
        parts.push(out);
      } else if (wireType === FIXED32) {
        parts.push(uint32(Number(item) >>> 0));
      } else {
        const data = typeof item === "string" ? encoder.encode(item) : item;
        parts.push(varint(data.length), data);
      }
    }
  }
  return concat(parts);
}

/**
 * A decoded protobuf: field number -> raw values (BigInt, or Uint8Array for
 * length-delimited fields).
 */
export class Message extends Map {
  static parse(data) {
    const message = new Message();
    const dv = view(data);
    let offset = 0;
    while (offset < data.length) {
      let key, value;
      [key, offset] = readVarint(data, offset);
      const wireType = Number(key & 7n);
      if (wireType === VARINT) {
        [value, offset] = readVarint(data, offset);
      } else if (wireType === FIXED64) {
        value = dv.getBigUint64(offset, true);
        offset += 8;
      } else if (wireType === BYTES) {
        let size;
        [size, offset] = readVarint(data, offset);
        value = data.subarray(offset, offset + Number(size));
        offset += Number(size);
      } else if (wireType === FIXED32) {
        value = BigInt(dv.getUint32(offset, true));
        offset += 4;
      } else {
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
      }
      const number = Number(key >> 3n);
      if (!message.has(number)) {
        message.set(number, []);
      }
      message.get(number).push(value);
    }
    return message;
  }

  first(number, fallback) {
    return this.has(number) ? this.get(number)[0] : fallback;
  }

  /** The first value as a Number, for fields that never need 64 bits. */
  int(number, fallback = 0) {
    return this.has(number) ? Number(this.get(number)[0]) : fallback;
  }

  text(number) {
    return decoder.decode(this.first(number, EMPTY));
  }

  /** A repeated varint field, whether or not the sender packed it. */
  uints(number) {
    const values = [];
    for (const value of this.get(number) ?? []) {
      if (value instanceof Uint8Array) {
        let offset = 0;
        while (offset < value.length) {
          let item;
          [item, offset] = readVarint(value, offset);
          values.push(Number(item));
        }
      } else {
        values.push(Number(value));
      }
    }
    return values;
  }
}

function float32(bits) {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits, true);
  return dv.getFloat32(0, true);
}

// --- CM connection ---

async function pickCmServers() {
  const url = new URL(
    "https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/",
  );
  url.search = new URLSearchParams({ cellid: 0, cmtype: "websockets" });
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) {
    throw new Error(`拿不到 Steam 伺服器清單（HTTP ${response.status}）`);
  }
  const servers = (await response.json()).response.serverlist.filter(
    (server) => server.type === "websockets" && server.realm === "steamglobal",
  );
  // Like steam-user: the five least loaded, in random order.
  servers.sort((a, b) => a.wtd_load - b.wtd_load);
  return servers
    .slice(0, 5)
    .map((server) => [Math.random(), server.endpoint])
    .sort(([a], [b]) => a - b)
    .map(([, endpoint]) => endpoint);
}

/**
 * Binary KV MessageObject with the three hashes Steam expects, derived from
 * `seed` so it stays the same between runs.
 */
async function machineId(seed) {
  async function entry(name) {
    const digest = await crypto.subtle.digest(
      "SHA-1",
      encoder.encode(`${DEVICE_NAME} ${name} ${seed}`),
    );
    return concat([
      [1],
      encoder.encode(name),
      [0],
      encoder.encode(toHex(digest)),
      [0],
    ]);
  }

  return concat([
    encoder.encode("\0MessageObject\0"),
    await entry("BB3"),
    await entry("FF2"),
    await entry("3B3"),
    [8, 8],
  ]);
}

export function jwtPayload(token) {
  const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload));
}

/**
 * One CM connection, made with `await SteamClient.connect(seed)`. close() logs
 * off, which also invalidates every ticket made on it.
 */
export class SteamClient {
  constructor(ws, machineIdBytes) {
    this.steamId = 0n;
    this.publicIp = 0;
    this.email = "";
    this._emailInfo = new Deferred();
    this._ws = ws;
    this._machineId = machineIdBytes;
    this._sessionId = 0n;
    this._heartbeat = null;
    this._lastJobId = 0n;
    this._jobs = new Map();
    this._logonResponse = null;
    this._connectTime = 0;
    this._gcTokens = [];
    this._gcTokensReceived = null;
    this._authTickets = [];
    this._authAppIds = new Set();
    this._authAcks = new Map();
    this._authSeqMe = 0;
    this._authSeqThem = 0;
    this._connectionCount = 0;
    this._steamPipe = 1 + Math.floor(Math.random() * 1_000_000);
    this._handlers = {
      [EMsg.ClientLogOnResponse]: this._onLogonResponse,
      [EMsg.ClientLoggedOff]: this._onLoggedOff,
      [EMsg.ClientEmailAddrInfo]: this._onEmailAddrInfo,
      [EMsg.ClientGameConnectTokens]: this._onGameConnectTokens,
      [EMsg.ClientAuthListAck]: this._onAuthListAck,
      [EMsg.ClientPlayingSessionState]: this._onPlayingSessionState,
    };

    // Messages are handled one at a time, in order, since unpacking a Multi is async.
    this._inbox = Promise.resolve();
    this._disconnected = new Deferred();
    const opened = new Deferred();
    this._opened = opened.promise;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => opened.resolve();
    ws.onerror = () =>
      opened.reject(new ConnectionError("連不上 Steam"));
    ws.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        this._inbox = this._inbox
          .then(() => this._dispatch(new Uint8Array(data)))
          .catch((e) => console.error("Cannot handle a Steam message", e));
      }
    };
    ws.onclose = () => {
      opened.reject(new ConnectionError("連不上 Steam"));
      this._inbox = this._inbox.then(() => this._onClose());
    };
  }

  static async connect(machineSeed) {
    const [endpoints, id] = await Promise.all([
      pickCmServers(),
      machineId(machineSeed),
    ]);
    // A CM now and then stops answering; move on to the next one.
    let error;
    for (const endpoint of endpoints.slice(0, CONNECT_ATTEMPTS)) {
      console.info("Connecting to Steam CM", endpoint);
      // CMs refuse websockets from origins other than Steam's own sites, so
      // rules.json makes this extension's connections claim steamcommunity.com.
      const steam = new SteamClient(
        new WebSocket(`wss://${endpoint}/cmsocket/`),
        id,
      );
      try {
        await withTimeout(
          steam._opened,
          OPEN_TIMEOUT,
          "連 Steam 逾時",
        );
        return steam;
      } catch (e) {
        steam._ws.close();
        console.warn(`Cannot connect to Steam CM ${endpoint}`, e);
        error = e;
      }
    }
    throw error;
  }

  async close() {
    clearInterval(this._heartbeat);
    if (this.steamId && !this._disconnected.done) {
      this._send(EMsg.ClientLogOff, EMPTY);
      // Steam replies with ClientLoggedOff and closes the connection.
      await Promise.race([this._disconnected.promise, sleep(4000)]);
    }
    this._ws.close();
  }

  // Logging on

  async logOn(refreshToken) {
    this.steamId = BigInt(jwtPayload(refreshToken).sub);
    this._logonResponse = new Deferred();
    this._send(
      EMsg.ClientLogon,
      pb(
        [1, VARINT, PROTOCOL_VERSION],
        [6, BYTES, "english"], // client_language
        [7, VARINT, OS_TYPE_WIN11], // client_os_type
        [8, VARINT, true], // should_remember_password
        [11, BYTES, pb([1, FIXED32, 0])], // obfuscated_private_ip, the logon ID
        [30, BYTES, this._machineId],
        [33, VARINT, 2], // chat_mode: new chat
        [102, VARINT, true], // supports_rate_limit_response
        [108, BYTES, refreshToken], // access_token
      ),
    );
    const [header, response] = await withTimeout(
      this._logonResponse.promise,
      TIMEOUT,
      "等 Steam 登入回應逾時",
    );

    const eresult = response.int(1, EResult.Fail);
    if (eresult !== EResult.OK) {
      this.steamId = 0n;
      throw new LogonError(eresult, "Steam 登入失敗");
    }

    this.steamId = header.first(1) || response.first(20) || this.steamId;
    this._sessionId = header.first(2, 0n);
    this.publicIp = Message.parse(response.first(15, EMPTY)).int(1, 0);
    this._connectTime = performance.now();
    this._heartbeat = setInterval(
      () => {
        if (this._ws.readyState === WebSocket.OPEN) {
          this._send(EMsg.ClientHeartBeat, EMPTY);
        }
      },
      response.int(3, 9) * 1000,
    );
  }

  gamesPlayed(appIds) {
    const games = appIds.map((appId) => pb([2, FIXED64, appId]));
    this._send(EMsg.ClientGamesPlayedWithDataBlob, pb([1, BYTES, games]));
  }

  /**
   * Add free apps to the account, like the store's "Play Game" button.
   * Returns the app IDs Steam granted.
   */
  async requestFreeLicense(appIds) {
    const [, body] = await this._call(
      EMsg.ClientRequestFreeLicense,
      pb([2, VARINT, appIds]),
    );
    const response = Message.parse(body);
    const eresult = response.int(1, EResult.Fail);
    if (eresult !== EResult.OK) {
      throw new SteamError(
        eresult,
        `無法替帳號加入免費遊戲 ${appIds}`,
      );
    }
    return response.uints(3);
  }

  // Tickets

  async getAppOwnershipTicket(appId) {
    const [, body] = await this._call(
      EMsg.ClientGetAppOwnershipTicket,
      pb([1, VARINT, appId]),
    );
    const response = Message.parse(body);
    const eresult = response.int(1, EResult.Fail);
    const ticket = response.first(3);
    if (eresult !== EResult.OK || !ticket?.length) {
      throw new SteamError(
        eresult,
        `拿不到遊戲 ${appId} 的擁有權票證`,
      );
    }
    return ticket;
  }

  /**
   * Like ISteamUser::GetAuthTicketForWebApi. The backend must pass the same
   * identity to ISteamUserAuth/AuthenticateUserTicket.
   */
  async getAuthTicketForWebApi(appId, identity = null) {
    const ownershipTicket = await this.getAppOwnershipTicket(appId);
    const gcToken = await this._takeGcToken();

    this._connectionCount += 1;
    const msSinceConnect =
      Math.floor(performance.now() - this._connectTime) >>> 0;
    const authTicket = concat([
      uint32(gcToken.length),
      gcToken,
      ...[
        SESSION_HEADER_SIZE,
        1, // unknown, always 1
        TICKET_TYPE_WEB_API,
        this.publicIp,
        0, // internal IP, left empty like steam-user does
        msSinceConnect,
        this._connectionCount,
      ].map(uint32),
    ]);
    const crc = crc32(authTicket);

    // Steam only accepts tickets it has seen in our auth list.
    this._authTickets.push(
      pb(
        [1, VARINT, 0], // estate
        [3, FIXED64, 0], // steamid, 0 for our own ticket
        [4, FIXED64, appId], // gameid
        [5, VARINT, this._steamPipe],
        [6, VARINT, crc],
        [7, BYTES, authTicket],
        // Steam prefixes the identity with "str:" and keeps the terminating NUL.
        [8, BYTES, identity ? `str:${identity}\0` : null],
      ),
    );
    this._authAppIds.add(appId);
    if (!(await this._sendAuthList(crc))) {
      // As in SteamKit2: the list was sent, and Steam validates the ticket
      // server-side when the backend calls AuthenticateUserTicket.
      console.warn(
        `Steam did not acknowledge auth ticket ${crc}; using it anyway`,
      );
    }

    const ticket = concat([
      authTicket,
      uint32(ownershipTicket.length),
      ownershipTicket,
    ]);
    const padded = new Uint8Array(Math.max(ticket.length, WEB_API_TICKET_SIZE));
    padded.set(ticket);
    crypto.getRandomValues(padded.subarray(ticket.length));
    return padded;
  }

  async _takeGcToken() {
    const tokensArrived = async () => {
      while (!this._gcTokens.length) {
        if (this._disconnected.done) {
          throw new ConnectionError("Steam 連線已中斷");
        }
        this._gcTokensReceived = new Deferred();
        await this._gcTokensReceived.promise;
      }
    };
    await withTimeout(
      tokensArrived(),
      TIMEOUT,
      "等 Steam 遊戲連線權杖逾時",
    );
    return this._gcTokens.shift();
  }

  async _sendAuthList(crc) {
    const acked = new Deferred();
    this._authAcks.set(crc, acked);
    this._authSeqMe += 1;
    try {
      this._send(
        EMsg.ClientAuthList,
        pb(
          [1, VARINT, this._gcTokens.length], // tokens_left
          [2, VARINT, this._authSeqMe - 1], // last_request_seq
          [3, VARINT, this._authSeqThem], // last_request_seq_from_server
          [4, BYTES, this._authTickets],
          [5, VARINT, [...this._authAppIds].sort((a, b) => a - b)],
          [6, VARINT, this._authSeqMe], // message_sequence
        ),
        { sourceJob: this._nextJobId() },
      );
      await withTimeout(acked.promise, TIMEOUT);
      return true;
    } catch (e) {
      if (e instanceof TimeoutError) {
        return false;
      }
      throw e;
    } finally {
      this._authAcks.delete(crc);
    }
  }

  // Credential login (IAuthenticationService over an anonymous connection)

  async callAuthService(method, body) {
    const [header, response] = await this._call(
      EMsg.ServiceMethodCallFromClientNonAuthed,
      body,
      {
        targetJobName: `Authentication.${method}#1`,
      },
    );
    const eresult = header.int(13, EResult.Fail);
    if (eresult !== EResult.OK) {
      throw new SteamError(
        eresult,
        (AUTH_METHOD_TEXT[method] ?? `Authentication.${method} 失敗`) +
          (header.text(14) ? `：${header.text(14)}` : ""),
      );
    }
    return Message.parse(response);
  }

  // Messaging

  _nextJobId() {
    this._lastJobId += 1n;
    return this._lastJobId;
  }

  _send(emsg, body, { sourceJob = JOBID_NONE, targetJobName = null } = {}) {
    if (this._ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError("Steam 連線已中斷");
    }
    const anonymous =
      emsg === EMsg.ClientHello ||
      emsg === EMsg.ServiceMethodCallFromClientNonAuthed;
    const header = pb(
      [1, FIXED64, anonymous ? 0 : this.steamId],
      [2, VARINT, anonymous ? 0 : this._sessionId],
      [10, FIXED64, sourceJob],
      [11, FIXED64, JOBID_NONE],
      [12, BYTES, targetJobName],
      [32, VARINT, targetJobName ? 1 : null], // realm: steamglobal
    );
    this._ws.send(
      concat([
        uint32((emsg | PROTO_MASK) >>> 0),
        uint32(header.length),
        header,
        body,
      ]),
    );
  }

  /** Send a message and wait for the reply addressed to its job ID. */
  async _call(emsg, body, options = {}) {
    const jobId = this._nextJobId();
    const reply = new Deferred();
    this._jobs.set(jobId, reply);
    try {
      this._send(emsg, body, { ...options, sourceJob: jobId });
      return await withTimeout(
        reply.promise,
        TIMEOUT,
        `等 Steam 回應逾時（EMsg ${emsg}）`,
      );
    } finally {
      this._jobs.delete(jobId);
    }
  }

  _onClose() {
    clearInterval(this._heartbeat);
    this._disconnected.resolve();
    const error = new ConnectionError("Steam 連線已中斷");
    const pending = [
      ...this._jobs.values(),
      ...this._authAcks.values(),
      this._logonResponse,
    ];
    for (const future of pending) {
      if (future && !future.done) {
        future.reject(error);
      }
    }
    this._gcTokensReceived?.resolve();
  }

  async _dispatch(data) {
    const dv = view(data);
    const rawEmsg = dv.getUint32(0, true);
    if (!(rawEmsg & PROTO_MASK)) {
      console.debug("Ignoring non-protobuf message", rawEmsg);
      return;
    }

    const emsg = rawEmsg & ~PROTO_MASK;
    const headerSize = dv.getUint32(4, true);
    const header = Message.parse(data.subarray(8, 8 + headerSize));
    const body = data.subarray(8 + headerSize);

    if (emsg === EMsg.Multi) {
      const multi = Message.parse(body);
      let payload = multi.first(2, EMPTY);
      if (multi.int(1)) {
        // size_unzipped
        payload = await gunzip(payload);
      }
      const payloadView = view(payload);
      let offset = 0;
      while (offset < payload.length) {
        const size = payloadView.getUint32(offset, true);
        await this._dispatch(payload.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
      return;
    }

    this._handlers[emsg]?.call(this, header, body);

    const reply = this._jobs.get(header.first(11, JOBID_NONE));
    if (reply && !reply.done) {
      reply.resolve([header, body]);
    }
  }

  _onLogonResponse(header, body) {
    if (this._logonResponse && !this._logonResponse.done) {
      this._logonResponse.resolve([header, Message.parse(body)]);
    }
  }

  _onLoggedOff(_header, body) {
    console.info("Logged off (EResult %d)", Message.parse(body).int(1));
  }

  _onEmailAddrInfo(_header, body) {
    this.email = Message.parse(body).text(1);
    this._emailInfo.resolve();
  }

  /** The account's email address, which Steam sends right after logging on. */
  async getEmail() {
    await Promise.race([this._emailInfo.promise, sleep(TIMEOUT)]);
    return this.email;
  }

  _onGameConnectTokens(_header, body) {
    const message = Message.parse(body);
    this._gcTokens.push(...(message.get(2) ?? []));
    // Keep max_tokens_to_keep.
    this._gcTokens.splice(0, this._gcTokens.length - message.int(1, 10));
    this._gcTokensReceived?.resolve();
  }

  _onAuthListAck(_header, body) {
    // Matched on ticket CRCs rather than the job ID, which Steam stopped
    // echoing on repeated auth lists (SteamRE/SteamKit#1567).
    const ack = Message.parse(body);
    this._authSeqThem = ack.int(3, 0);
    for (const crc of ack.uints(1)) {
      const acked = this._authAcks.get(crc);
      if (acked && !acked.done) {
        acked.resolve();
      }
    }
  }

  _onPlayingSessionState(_header, body) {
    const state = Message.parse(body);
    if (state.int(2)) {
      console.warn(
        `Another session is playing app ${state.int(3)}; tickets may be rejected`,
      );
    }
  }
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) {
      result = (result * base) % modulus;
    }
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/** RSA with PKCS#1 v1.5 padding, which Steam uses for login passwords. */
function rsaEncrypt(message, modulus, exponent) {
  const size = Math.ceil(modulus.toString(2).length / 8);
  const padding = crypto.getRandomValues(
    new Uint8Array(size - 3 - message.length),
  );
  for (let i = 0; i < padding.length; i++) {
    while (padding[i] === 0) {
      padding[i] = crypto.getRandomValues(new Uint8Array(1))[0];
    }
  }
  const block = concat([[0, 2], padding, [0], message]);
  const encrypted = modPow(BigInt(`0x${toHex(block)}`), exponent, modulus);
  return fromHex(encrypted.toString(16).padStart(size * 2, "0"));
}

/**
 * Sign in as a Steam client and return a refresh token for logOn.
 *
 * askCode(kind, retry) receives "email" or "device", and whether the previous
 * code was wrong, and resolves to a Steam Guard code. log(message) shows
 * progress to the user.
 */
export async function logInWithPassword(
  accountName,
  password,
  { machineSeed, askCode, log },
) {
  const steam = await SteamClient.connect(machineSeed);
  try {
    steam._send(EMsg.ClientHello, pb([1, VARINT, PROTOCOL_VERSION]));

    const key = await steam.callAuthService(
      "GetPasswordRSAPublicKey",
      pb([1, BYTES, accountName]),
    );
    const encryptedPassword = rsaEncrypt(
      encoder.encode(password),
      BigInt(`0x${key.text(1)}`),
      BigInt(`0x${key.text(2)}`),
    );
    const deviceDetails = pb(
      [1, BYTES, DEVICE_NAME],
      [2, VARINT, PLATFORM_TYPE_STEAM_CLIENT],
      [3, VARINT, OS_TYPE_WIN11],
      [4, VARINT, 1], // gaming_device_type: desktop PC
      [6, BYTES, steam._machineId],
    );
    const session = await steam.callAuthService(
      "BeginAuthSessionViaCredentials",
      pb(
        [2, BYTES, accountName],
        [3, BYTES, btoa(String.fromCharCode(...encryptedPassword))],
        [4, VARINT, key.first(3)], // encryption_timestamp
        [5, VARINT, true], // remember_login
        [7, VARINT, 1], // persistence: persistent
        [8, BYTES, "Unknown"], // website_id, what the Steam client sends
        [9, BYTES, deviceDetails],
      ),
    );
    let clientId = session.first(1);
    const requestId = session.first(2);
    const sessionSteamId = session.first(5);
    const interval = float32(session.int(3, 0));
    const guards = new Set(
      (session.get(4) ?? []).map((c) => Message.parse(c).int(1)),
    );

    if (
      guards.has(EAuthSessionGuardType.EMAIL_CODE) ||
      guards.has(EAuthSessionGuardType.DEVICE_CODE)
    ) {
      const codeType = guards.has(EAuthSessionGuardType.EMAIL_CODE)
        ? EAuthSessionGuardType.EMAIL_CODE
        : EAuthSessionGuardType.DEVICE_CODE;
      let retry = false;
      for (;;) {
        const code = await askCode(
          codeType === EAuthSessionGuardType.EMAIL_CODE ? "email" : "device",
          retry,
        );
        try {
          await steam.callAuthService(
            "UpdateAuthSessionWithSteamGuardCode",
            pb(
              [1, VARINT, clientId],
              [2, FIXED64, sessionSteamId],
              [3, BYTES, code],
              [4, VARINT, codeType],
            ),
          );
          break;
        } catch (e) {
          if (
            !(e instanceof SteamError) ||
            ![
              EResult.InvalidLoginAuthCode,
              EResult.TwoFactorCodeMismatch,
            ].includes(e.eresult)
          ) {
            throw e;
          }
          retry = true;
        }
      }
    } else if (!guards.has(EAuthSessionGuardType.NONE)) {
      log(
        "請在 Steam 手機 App 或 Steam 寄來的信裡按「核准」這次登入",
      );
    }

    const deadline = performance.now() + LOGIN_TIMEOUT;
    for (;;) {
      const status = await steam.callAuthService(
        "PollAuthSessionStatus",
        pb([1, VARINT, clientId], [2, BYTES, requestId]),
      );
      clientId = status.first(1, clientId); // new_client_id
      const refreshToken = status.text(3);
      if (refreshToken) {
        return refreshToken;
      }
      if (performance.now() > deadline) {
        throw new TimeoutError("等太久都沒有核准這次登入");
      }
      await sleep((interval || 5) * 1000);
    }
  } finally {
    await steam.close();
  }
}

/**
 * Log on with a refresh token, which checks that Steam still accepts it, and
 * return the account's Steam ID and email address. Throws LogonError otherwise.
 */
export async function getAccountInfo(refreshToken, { machineSeed }) {
  const steam = await SteamClient.connect(machineSeed);
  try {
    await steam.logOn(refreshToken);
    return {
      steamId: steam.steamId.toString(),
      email: await steam.getEmail(),
    };
  } finally {
    await steam.close();
  }
}

/**
 * Ask Steam for a new refresh token, like steam-session's renewRefreshToken.
 * Steam decides whether to issue one; when it does, the old token stops
 * working, so the caller must save the result. Returns null when Steam keeps
 * the current token.
 */
export async function renewRefreshToken(refreshToken, { machineSeed }) {
  const steam = await SteamClient.connect(machineSeed);
  try {
    steam._send(EMsg.ClientHello, pb([1, VARINT, PROTOCOL_VERSION]));
    const response = await steam.callAuthService(
      "GenerateAccessTokenForApp",
      pb(
        [1, BYTES, refreshToken],
        [2, FIXED64, BigInt(jwtPayload(refreshToken).sub)],
        [3, VARINT, 1], // renewal_type: allow
      ),
    );
    return response.text(2) || null;
  } finally {
    await steam.close();
  }
}
