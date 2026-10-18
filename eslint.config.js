// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // ⚠ `.wrangler/` 是 wrangler 的產物（打包後的 bundle 與本機狀態）。
    // 不擋的話 lint 會去檢查那份 bundle，然後對著 Cloudflare 的全域
    // （Response、WebSocketPair…）報一整排 no-undef。
    // tools/.probe-* 是對著跑著的遊戲查東西的一次性腳本（/probe-game），不進版控、不該擋發版。
    // steam-login-extension 是別人寫的 Steam 登入擴充，原樣收進來（上游更新時整包蓋過去），不改它的寫法。
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/*.json",
      "tools/.probe-*",
      "apps/tray/assets/steam-login-extension/**",
    ],
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
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 托盤視窗的畫面（2026-10-18 從 index.html 的一整支 inline script 拆出來）。
    // 是瀏覽器裡的 classic script、不經過 tsc：幾支共用同一個全域，一支宣告的
    // 函式／常數另一支直接用，所以 no-undef 與「頂層沒用到」在單一檔案裡看不出對錯，關掉；
    // 函式內的區域變數照樣檢查。全形空白是文案裡刻意放的（模板字串）。
    files: ["apps/tray/renderer/**/*.js"],
    languageOptions: { sourceType: "script" },
    rules: {
      "no-undef": "off",
      "no-irregular-whitespace": ["error", { skipTemplates: true }],
    },
  },
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
  {
    // 托盤畫面：頂層宣告是給別支用的（見上面那段），只檢查區域變數。要放在通用那段後面才蓋得過。
    files: ["apps/tray/renderer/**/*.js"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { vars: "local", argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
