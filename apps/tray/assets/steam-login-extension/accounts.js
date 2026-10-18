// Saved Steam accounts, keyed by Steam ID so a bookmark always signs in the
// account it names.
//
// Passwords are never stored. A refresh token the user asks to remember is
// kept in chrome.storage.local, AES-GCM encrypted with a non-extractable key
// that lives in this extension's IndexedDB, so it is never written to disk in
// plain text. Tokens that are not remembered only live in
// chrome.storage.session, which stays in memory and is cleared when the
// browser closes. Neither area is open to the extension's content scripts on
// the game page (see background.js), so only its own pages can read them.

import { jwtPayload } from "./steam_cm.js";

const ACCOUNT_PREFIX = "account:";
const SESSION_TOKEN_PREFIX = "token:";
const KEY_DB = "keys";
const KEY_STORE = "keys";
const TOKEN_KEY_ID = "refresh-token";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const accountKey = (steamId) => ACCOUNT_PREFIX + steamId;
const sessionKey = (steamId) => SESSION_TOKEN_PREFIX + steamId;

export class SignedOutError extends Error {
  name = "SignedOutError";
}

export const isSteamId = (value) => /^\d{17}$/.test(value ?? "");

/** What a refresh token says about itself, or null if it is not a Steam JWT. */
export function tokenInfo(refreshToken) {
  try {
    const { sub, exp } = jwtPayload(refreshToken);
    return isSteamId(sub) ? { steamId: sub, expires: exp * 1000 } : null;
  } catch {
    return null;
  }
}

export function displayName(account) {
  return account.accountName || `Steam 帳號 ${account.steamId}`;
}

export function launchUrl(steamId) {
  return `${chrome.runtime.getURL("launcher.html")}?steamid=${steamId}`;
}

/** The link to bookmark, on the game site; game.js sends it on to launchUrl. */
export function bookmarkUrl(steamId) {
  return `https://www.playunlight.online/?steamid=${steamId}`;
}

/** A random ID standing in for the hostname that seeds the Python machine ID. */
export function getMachineSeed() {
  return navigator.locks.request("machine-seed", async () => {
    let { machineSeed } = await chrome.storage.local.get("machineSeed");
    if (!machineSeed) {
      machineSeed = crypto.randomUUID();
      await chrome.storage.local.set({ machineSeed });
    }
    return machineSeed;
  });
}

// --- Token encryption ---

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let tokenKey = null;

function getTokenKey() {
  tokenKey ??= navigator.locks
    .request("token-key", async () => {
      const open = indexedDB.open(KEY_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(KEY_STORE);
      const db = await idbRequest(open);
      try {
        const store = (mode) =>
          db.transaction(KEY_STORE, mode).objectStore(KEY_STORE);
        let key = await idbRequest(store("readonly").get(TOKEN_KEY_ID));
        if (!key) {
          key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          await idbRequest(store("readwrite").put(key, TOKEN_KEY_ID));
        }
        return key;
      } finally {
        db.close();
      }
    })
    .catch((e) => {
      tokenKey = null;
      throw e;
    });
  return tokenKey;
}

const toBase64 = (data) => btoa(String.fromCharCode(...new Uint8Array(data)));
const fromBase64 = (text) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// The Steam ID is authenticated along with the token, so a ciphertext copied
// to another account's record does not decrypt.
async function encryptToken(refreshToken, steamId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(steamId) },
    await getTokenKey(),
    encoder.encode(refreshToken),
  );
  return { iv: toBase64(iv), data: toBase64(data) };
}

async function decryptToken({ iv, data }, steamId) {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(iv),
      additionalData: encoder.encode(steamId),
    },
    await getTokenKey(),
    fromBase64(data),
  );
  return decoder.decode(plain);
}

// --- Accounts ---

// Records hold { steamId, accountName, email, remember, expires, token },
// where token is the encrypted refresh token of a remembered account.
function publicView({ token, ...account }, session) {
  const hasToken = account.remember
    ? Boolean(token)
    : sessionKey(account.steamId) in session;
  return { ...account, signedIn: hasToken && account.expires > Date.now() };
}

export async function listAccounts() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.storage.session.get(null),
  ]);
  return Object.entries(local)
    .filter(([key]) => key.startsWith(ACCOUNT_PREFIX))
    .map(([, record]) => publicView(record, session))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

export async function getAccount(steamId) {
  const [{ [accountKey(steamId)]: record }, session] = await Promise.all([
    chrome.storage.local.get(accountKey(steamId)),
    chrome.storage.session.get(sessionKey(steamId)),
  ]);
  return record ? publicView(record, session) : null;
}

export function onAccountsChanged(callback) {
  chrome.storage.onChanged.addListener((changes) => {
    const keys = Object.keys(changes);
    if (
      keys.some(
        (key) =>
          key.startsWith(ACCOUNT_PREFIX) ||
          key.startsWith(SESSION_TOKEN_PREFIX),
      )
    ) {
      callback();
    }
  });
}

async function readToken(steamId) {
  const { [accountKey(steamId)]: record } = await chrome.storage.local.get(
    accountKey(steamId),
  );
  if (!record) {
    return null;
  }
  let refreshToken = null;
  if (!record.remember) {
    ({ [sessionKey(steamId)]: refreshToken = null } =
      await chrome.storage.session.get(sessionKey(steamId)));
  } else if (record.token) {
    try {
      refreshToken = await decryptToken(record.token, steamId);
    } catch (e) {
      console.warn("Cannot decrypt the saved refresh token", e);
    }
  }
  // Never hand out a token for another account, whatever is in storage.
  return tokenInfo(refreshToken)?.steamId === steamId ? refreshToken : null;
}

/** Callers hold the account lock. A null refreshToken signs out. */
async function writeAccount(steamId, changes) {
  const { [accountKey(steamId)]: current } = await chrome.storage.local.get(
    accountKey(steamId),
  );
  const record = {
    steamId,
    accountName: "",
    email: "",
    remember: true,
    expires: 0,
    token: null,
    ...current,
  };
  for (const field of ["accountName", "email", "remember"]) {
    if (changes[field] !== undefined) {
      record[field] = changes[field];
    }
  }
  const { refreshToken } = changes;
  if (refreshToken !== undefined) {
    if (refreshToken && tokenInfo(refreshToken)?.steamId !== steamId) {
      throw new Error(`這個登入憑證不是 Steam 帳號 ${steamId} 的`);
    }
    record.expires = refreshToken ? tokenInfo(refreshToken).expires : 0;
    record.token =
      refreshToken && record.remember
        ? await encryptToken(refreshToken, steamId)
        : null;
    if (refreshToken && !record.remember) {
      await chrome.storage.session.set({ [sessionKey(steamId)]: refreshToken });
    } else {
      await chrome.storage.session.remove(sessionKey(steamId));
    }
  }
  await chrome.storage.local.set({ [accountKey(steamId)]: record });
}

// Renewing a refresh token invalidates the old one, so everything that uses or
// replaces an account's token holds this lock, across all of this extension's tabs.
function lockAccount(steamId, callback) {
  return navigator.locks.request(`account:${steamId}`, callback);
}

/**
 * Run callback(refreshToken, save) while holding the account's lock.
 * save({ refreshToken, email }) updates the account; a null refreshToken
 * signs it out. Throws SignedOutError when the account has no usable token.
 */
export function useAccount(steamId, callback) {
  return lockAccount(steamId, async () => {
    const refreshToken = await readToken(steamId);
    if (!refreshToken || tokenInfo(refreshToken).expires <= Date.now()) {
      throw new SignedOutError(`Steam 帳號 ${steamId} 沒有登入`);
    }
    return callback(refreshToken, (changes) => writeAccount(steamId, changes));
  });
}

/** Save a newly signed-in account, replacing any token it had. Returns its Steam ID. */
export async function saveAccount(
  refreshToken,
  { accountName, email, remember },
) {
  const { steamId } = tokenInfo(refreshToken);
  await lockAccount(steamId, () =>
    writeAccount(steamId, {
      accountName,
      // Keep the known address if Steam did not send one this time.
      email: email || undefined,
      remember,
      refreshToken,
    }),
  );
  return steamId;
}

export function removeAccount(steamId) {
  return lockAccount(steamId, () =>
    Promise.all([
      chrome.storage.local.remove(accountKey(steamId)),
      chrome.storage.session.remove(sessionKey(steamId)),
    ]),
  );
}
