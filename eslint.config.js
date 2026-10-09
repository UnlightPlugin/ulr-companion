// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // ⚠ `.wrangler/` 是 wrangler 的產物（打包後的 bundle 與本機狀態）。
    // 不擋的話 lint 會去檢查那份 bundle，然後對著 Cloudflare 的全域
    // （Response、WebSocketPair…）報一整排 no-undef。
    // tools/.probe-* 是對著跑著的遊戲查東西的一次性腳本（/probe-game），不進版控、不該擋發版。
    ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "**/*.json", "tools/.probe-*"],
  },
  {
    // scripts/ 底下是給 Node 直接跑的建置腳本，不是 package 的一部分。
    // 專案沒裝 `globals`，所以這裡手動列出用到的那幾個就好。
    // tools/ 底下的維護腳本同一回事。⚠ 只列進版控的那一支：本機的
    // release-local.mjs 自己用 `/* global */` 宣告，兩邊都給會變 no-redeclare。
    files: ["scripts/**/*.mjs", "tools/scrape-raid-treasure.mjs", "tools/build-quest-treasure.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    // 網頁版開機用的 Chrome 擴充：原樣複製進使用者資料夾給瀏覽器載，
    // 跑在頁面（content script）跟 service worker 裡，不經過 tsc。
    files: ["apps/tray/assets/ulr-boot-extension/**/*.js"],
    languageOptions: {
      globals: {
        chrome: "readonly",
        window: "readonly",
        document: "readonly",
        location: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        Event: "readonly",
        HTMLMediaElement: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 規格書 §12：規則內容只能驅動白名單化的計算分支，
      // 不得轉譯為 eval / Function / 動態模組載入。
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
);
