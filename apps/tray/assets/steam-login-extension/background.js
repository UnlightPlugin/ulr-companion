import { isSteamId, launchUrl } from "./accounts.js";
import { faviconUrl, getGameSettings } from "./game_settings.js";

const GAME_ORIGIN = "https://www.playunlight.online";

// Keep saved accounts away from content scripts; they ask here for what they
// need. chrome.storage.session is closed to them by default. Set on every
// start, with an onStartup listener so the worker starts with the browser.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.runtime.onStartup.addListener(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.origin !== GAME_ORIGIN || !sender.tab) {
    return false;
  }
  if (message?.type === "game-settings") {
    getGameSettings().then(({ favicon, ...settings }) =>
      sendResponse({ ...settings, faviconUrl: faviconUrl(favicon) }),
    );
    return true;
  }
  if (message?.type === "relaunch" && isSteamId(message.steamId)) {
    chrome.tabs.update(sender.tab.id, { url: launchUrl(message.steamId) });
  }
  return false;
});
