// The rest of src/script/ulr_steam.js for the game page: show only the game,
// then apply the title, icon, layout and scaling chosen on the settings page.
// The page loads its own game scripts, so their names are never hard-coded;
// game_main.js deals with SERVER, which lives in the page's JavaScript world.

(() => {
  const SITE_ELEMENTS = [
    ".banner1",
    ".banner2",
    ".top_bg",
    ".comic",
    'link[rel="stylesheet"][href*="style-dmm.css"]',
  ].join(", ");

  // Content scripts cannot read the extension's storage; the background
  // script hands out the game settings instead.
  const settings = chrome.runtime
    .sendMessage({ type: "game-settings" })
    .catch((e) => console.error("Cannot get the game page settings", e));

  // Drop the website around the game as the parser adds it, before it shows.
  const removeSiteElements = () => {
    for (const element of document.querySelectorAll(SITE_ELEMENTS)) {
      element.remove();
    }
  };
  const observer = new MutationObserver(removeSiteElements);
  observer.observe(document, { childList: true, subtree: true });

  function fitToWindow(canvas) {
    const style = document.createElement("style");
    style.textContent = `
      body {
        width: 100vw;
        height: 100vh;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background-color: #000000;
      }
      #myCustomCanvas {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        transform-origin: center center;
      }
    `;
    document.head.append(style);
    const scale = () => {
      if (!canvas.clientWidth || !canvas.clientHeight) {
        return;
      }
      const factor = Math.min(
        innerWidth / canvas.clientWidth,
        innerHeight / canvas.clientHeight,
      );
      canvas.style.transform = `translate(-50%, -50%) scale(${factor})`;
    };
    scale();
    addEventListener("resize", scale);
    // The game resizes the canvas once it starts.
    new ResizeObserver(scale).observe(canvas);
  }

  function apply({ title, faviconUrl, steamCss, autoResize }, canvas) {
    if (steamCss) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "stylesheets/style-steam.css";
      document.head.append(css);
    }
    if (title) {
      document.title = title;
    }
    if (faviconUrl) {
      const icon = document.createElement("link");
      icon.rel = "icon";
      icon.href = faviconUrl;
      document.head.append(icon);
    }
    if (autoResize) {
      fitToWindow(canvas);
    }
  }

  // The server answers 403 to a game link whose access token it no longer
  // takes, such as an old link or a reload, and to a bookmark link,
  // /?steamid=<Steam ID> as with the userscript. Sign that account in.
  function relaunch() {
    const params = new URLSearchParams(location.search);
    const steamId = params.get("platform_id") ?? params.get("steamid");
    if (
      location.pathname !== "/" ||
      (params.get("platform_type") ?? "steam") !== "steam" ||
      !/^\d{17}$/.test(steamId ?? "")
    ) {
      return;
    }
    document.body.textContent = "重新登入中…";
    chrome.runtime.sendMessage({ type: "relaunch", steamId });
  }

  document.addEventListener(
    "DOMContentLoaded",
    async () => {
      observer.disconnect();
      removeSiteElements();
      const canvas = document.getElementById("myCustomCanvas");
      if (canvas) {
        const chosen = await settings;
        if (chosen) {
          apply(chosen, canvas);
        }
      } else if (/^\s*403\b/.test(document.body?.textContent ?? "")) {
        relaunch();
      }
    },
    { once: true },
  );
})();
