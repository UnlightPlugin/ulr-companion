// Where a bookmark link, https://www.playunlight.online/?steamid=<Steam ID>,
// ends up (see game.js): launcher.html?steamid=<Steam ID> signs in that
// account, and only that account, then opens the game in this tab. Signing in happens
// in a tab rather than the popup, which closes (and drops the Steam
// connection) as soon as the user switches away to fetch a Steam Guard code.

import { LogonError, TOKEN_REJECTED, renewRefreshToken } from "./steam_cm.js";
import {
  SignedOutError,
  displayName,
  getAccount,
  getMachineSeed,
  isSteamId,
  tokenInfo,
  useAccount,
} from "./accounts.js";
import { mountLogin } from "./login.js";
import { signIn } from "./unlight.js";

// Renew a refresh token this close to expiring, so a bookmark in regular use
// never needs the password again.
const RENEW_BEFORE = 30 * 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const steamId = new URLSearchParams(location.search).get("steamid");

function log(message, kind = "info") {
  $("status").textContent = message;
  $("status").dataset.kind = kind;
}

async function showLogin(message) {
  const account = await getAccount(steamId);
  log(message, "error");
  $("login").hidden = false;
  mountLogin($("login"), {
    steamId,
    accountName: account?.accountName,
    log,
    onSignedIn: launch,
  });
}

async function renewIfExpiring(refreshToken, save, machineSeed) {
  if (tokenInfo(refreshToken).expires - Date.now() > RENEW_BEFORE) {
    return refreshToken;
  }
  log("更新 Steam 登入中");
  try {
    const renewed = await renewRefreshToken(refreshToken, { machineSeed });
    if (renewed) {
      await save({ refreshToken: renewed });
      return renewed;
    }
  } catch (e) {
    console.warn("Cannot renew the refresh token", e);
  }
  return refreshToken;
}

async function launch() {
  $("login").hidden = true;
  $("retry").hidden = true;
  log("等待 Steam");
  const machineSeed = await getMachineSeed();
  try {
    const url = await useAccount(steamId, async (refreshToken, save) => {
      refreshToken = await renewIfExpiring(refreshToken, save, machineSeed);
      try {
        const { url, email } = await signIn(refreshToken, {
          steamId,
          machineSeed,
          log,
        });
        if (email) {
          await save({ email });
        }
        return url;
      } catch (e) {
        if (e instanceof LogonError && TOKEN_REJECTED.has(e.eresult)) {
          await save({ refreshToken: null });
        }
        throw e;
      }
    });
    log("開啟遊戲");
    location.replace(url);
  } catch (e) {
    console.error(e);
    if (e instanceof SignedOutError) {
      await showLogin("請登入這個帳號才能開始玩");
    } else if (e instanceof LogonError && TOKEN_REJECTED.has(e.eresult)) {
      await showLogin(
        `Steam 不再接受儲存的登入（${e.message}），請重新登入`,
      );
    } else {
      log(e.message, "error");
      $("retry").hidden = false;
    }
  }
}

async function main() {
  $("retry-button").addEventListener("click", launch);
  if (!isSteamId(steamId)) {
    log(
      "這個連結沒有指定 Steam 帳號，請到「管理帳號」重新複製。",
      "error",
    );
    return;
  }
  const account = await getAccount(steamId);
  const name = account ? displayName(account) : `Steam 帳號 ${steamId}`;
  $("account").textContent = name;
  document.title = `${name} - UNLIGHT:Revive`;
  if (!account) {
    await showLogin("這個帳號還沒在這個瀏覽器登入過");
  } else if (!account.signedIn) {
    await showLogin("請重新登入這個帳號");
  } else {
    await launch();
  }
}

main().catch((e) => {
  console.error(e);
  log(e.message, "error");
});
