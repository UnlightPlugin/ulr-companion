// How the game page looks, chosen on the settings page. These are the settings
// of src/script/ulr_steam.js, minus the ones the extension no longer needs.

const KEY = "gameSettings";

export const FAVICONS = {
  rose: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQIAJQAlAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAAgACABAREA/8QAGAABAQEBAQAAAAAAAAAAAAAABwgGAAH/xAAuEAACAQMDAwIFAwUAAAAAAAABAgMEBREGEiEACBMiQQcUIzGBJFFhYmNxwfD/2gAIAQEAAD8AlUDJwOqF0d29UItlJXfEPVdJYpKlFdKASRpKob7bmc4Df0gH/PWq1f222C9WGGt+Gd4jeenjZHWWcTx1bj+4DhH9iMY+3C8kyvX0dRb66oo62F4KqnkaKWJxhkdTgg/yCOlntg0BFrXXhqa9pFt1nVKqTxsVZ5N301yORyCcjn0/nqnaW60tFd6yooLJb8wVs9MtVWSrSU9IkeFdg21izM+MsByXVSfTx5Vag31du1JZLUy10jSCqjpp0kiudKgkEjRspxIyFVZSwUkHaMBjiZO6ukgT4rVFxoU/SXGmgnWVR6JW8YyR+Np/PST2Uags8SXqweBob5ORVGdnyJ4k9IQD2K7iffO4n26T7d8jU2qG3RfIzansNRVeW31snhNTv3+QhiPtIJFcOAQCRn367Td007QoklHW09wvlDC9NbLLA4/SZUAwoABuJK4MhHAz9gCSId11spNO6e0FYPmfm7nSQTNNM2NxXESA49l9GFHsEx0B2O719iu1Nc7PVS0lfTPvimjOCp/2McEHgjjpjtvcRcXqI5NT6as18zjz+RAnlK8K+CGVXA43AcjAI4BG5m7s4IYoUoNGFVUAFXrwoUfsuI/+/bqefiNq6s1xrC436vBjapf6cO/eIYxwqA8cAfwMnJ9+v//Z",
  green:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAJ9JREFUeNq01ssOwyAMRFG46v//Mt1ESmgh+DFmE2GPOBARKb2NVjo+17PXLD8a1+pl5+A+wSgFygymWYHBb0FtsKhJDdZlncG2IzJ4ayoMDv20wTmSMzClEgbWYNTAkQ0Z+OJ+A/eWnAaR9+oxCF4Os0H8htsMUp+pwcgBBiMNnAwF8GqIgL2hAzaGFFgZauDPKABmowZ4GL369/0rwACp2yA/ttmvsQAAAABJRU5ErkJggg==",
  frum: "https://cdn.discordapp.com/emojis/686187711752700008.webp",
};

export const DEFAULT_GAME_SETTINGS = {
  title: "UNLIGHT:Revive",
  // A FAVICONS name, an image URL, or "" for the site's own icon.
  favicon: "rose",
  // The site's style-steam.css, which centers the game.
  steamCss: true,
  // Scale the game canvas to fit the window.
  autoResize: false,
};

export async function getGameSettings() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  const settings = { ...DEFAULT_GAME_SETTINGS, ...saved };
  // An icon no longer offered, such as "blank", falls back to the site's own.
  if (!faviconUrl(settings.favicon)) {
    settings.favicon = "";
  }
  return settings;
}

export async function setGameSettings(changes) {
  await chrome.storage.local.set({
    [KEY]: { ...(await getGameSettings()), ...changes },
  });
}

export function faviconUrl(favicon) {
  if (Object.hasOwn(FAVICONS, favicon)) {
    return FAVICONS[favicon];
  }
  return /^(https?:|data:image\/)/.test(favicon) ? favicon : "";
}
