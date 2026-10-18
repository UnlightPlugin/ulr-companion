// The UNLIGHT:Revive half of src/steam_app.py: turn a Steam refresh token into
// a signed-in game URL.

import { EResult, SteamClient, SteamError } from "./steam_cm.js";

const STEAM_APP_ID = 3247080;
const TICKET_IDENTITY = "UNLIGHT";
const AUTH_HOST = "wss://www.playunlight-yiylzpm2ugvd227f.site";
const AUTH_PORTS = Array.from({ length: 10 }, (_, i) => 12002 + i);
const AUTH_TIMEOUT = 30_000;
const GAME_URL = "https://www.playunlight.online/";

/**
 * Trade a Steam ticket for an access token. The server speaks Socket.IO, of
 * which only a websocket-only Engine.IO v4 connection is needed here.
 */
function authenticate(steamId, ticket) {
  const port = AUTH_PORTS[Math.floor(Math.random() * AUTH_PORTS.length)];
  const ws = new WebSocket(
    `${AUTH_HOST}:${port}/socket.io/?EIO=4&transport=websocket`,
  );
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("遊戲的登入伺服器太久沒回應")),
      AUTH_TIMEOUT,
    );
    ws.onerror = () => reject(new Error("連不上遊戲的登入伺服器"));
    ws.onclose = () =>
      reject(new Error("遊戲的登入伺服器斷線了"));
    ws.onmessage = ({ data }) => {
      // An Engine.IO packet type, then for messages (4) a Socket.IO packet type.
      if (typeof data !== "string") {
        return;
      }
      if (data === "2") {
        ws.send("3"); // ping -> pong
      } else if (data.startsWith("0")) {
        ws.send("40"); // open -> connect to the default namespace
      } else if (data.startsWith("40")) {
        ws.send(`42${JSON.stringify(["authenticate", steamId, ticket])}`);
      } else if (data.startsWith("44")) {
        reject(
          new Error(`遊戲的登入伺服器拒絕連線：${data.slice(2)}`),
        );
      } else if (data === "1" || data === "41") {
        reject(new Error("遊戲的登入伺服器斷線了"));
      } else if (data.startsWith("42")) {
        const [event, token] = JSON.parse(data.slice(2));
        if (event !== "authenticate") {
          return;
        }
        // The server answers null when it rejects the ticket.
        if (token) {
          resolve(token);
        } else {
          reject(new Error("遊戲的登入伺服器不收這張 Steam 票證"));
        }
      }
    };
  }).finally(() => {
    clearTimeout(timer);
    ws.onclose = null;
    ws.close();
  });
}

const toHex = (data) =>
  Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Log on to Steam as account `steamId` with its refresh token and return the
 * game URL and the account's email address. Throws LogonError when Steam refuses the token.
 */
export async function signIn(refreshToken, { steamId, machineSeed, log }) {
  log("連線到 Steam");
  const steam = await SteamClient.connect(machineSeed);
  try {
    await steam.logOn(refreshToken);
    if (steam.steamId.toString() !== steamId) {
      throw new Error(`Steam 登入成 ${steam.steamId}，不是要的 ${steamId}`);
    }
    // The real client asks while the game is running, and a ticket may not
    // validate unless Steam sees us in-game.
    steam.gamesPlayed([STEAM_APP_ID]);
    log("向 Steam 拿遊戲票證");
    let ticket;
    try {
      ticket = await steam.getAuthTicketForWebApi(
        STEAM_APP_ID,
        TICKET_IDENTITY,
      );
    } catch (e) {
      if (!(e instanceof SteamError) || e.eresult !== EResult.AccessDenied) {
        throw e;
      }
      // The game is free, so an account that never added it can claim it here.
      log(
        "這個 Steam 帳號還沒有 UNLIGHT:Revive，正在加入免費授權",
      );
      if (
        !(await steam.requestFreeLicense([STEAM_APP_ID])).includes(STEAM_APP_ID)
      ) {
        throw new Error("Steam 沒有給 UNLIGHT:Revive 的授權", {
          cause: e,
        });
      }
      ticket = await steam.getAuthTicketForWebApi(
        STEAM_APP_ID,
        TICKET_IDENTITY,
      );
    }
    // Stay logged on until the backend has validated the ticket, since
    // logging off invalidates it.
    log("登入 UNLIGHT:Revive");
    const token = await authenticate(steamId, toHex(ticket));

    const query = new URLSearchParams({
      platform_id: steamId,
      platform_key: "unlight",
      platform_type: "steam",
      access_token: token,
    });
    return { url: `${GAME_URL}?${query}`, email: steam.email };
  } finally {
    await steam.close();
  }
}
