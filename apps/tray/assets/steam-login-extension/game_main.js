// Runs in the game page's own JavaScript world, before the page's scripts.
//
// The page is the one the Steam client shows, and with SERVER set to "steam"
// the game loads its fonts from ulfont://, which only the Electron client
// serves. So until the fonts are in, the game sees "dmm" and loads them from
// the website like the DMM version does; after that it sees the page's value.

(() => {
  // What the DMM path loads: BradleyGratis twice and four Source Han Serif weights.
  const FONT_COUNT = 6;

  let pageServer;
  let gameScriptsStarted = false;
  let fontsLoaded = false;
  Object.defineProperty(window, "SERVER", {
    configurable: true,
    get: () =>
      gameScriptsStarted && !fontsLoaded ? "dmm" : (pageServer ?? "steam"),
    set: (value) => {
      pageServer = value;
      // The inline script that sets SERVER goes on to build platform_config
      // from it, so only the scripts after it see "dmm".
      queueMicrotask(() => {
        gameScriptsStarted = true;
      });
    },
  });

  const timer = setInterval(() => {
    const loaded = [...document.fonts].filter(
      (font) => font.status === "loaded",
    );
    if (loaded.length >= FONT_COUNT) {
      fontsLoaded = true;
      clearInterval(timer);
    }
  }, 100);

  // Nothing to wait for on a page without the game, such as a 403.
  document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("myCustomCanvas")) {
      clearInterval(timer);
    }
  });
})();
