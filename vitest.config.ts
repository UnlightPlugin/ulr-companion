import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // 對齊 tsconfig 的 paths，測試不用先 build
    alias: {
      "@ulr/rule-schema/canonical": r("./packages/rule-schema/src/canonical.ts"),
      "@ulr/rule-schema": r("./packages/rule-schema/src/index.ts"),
      "@ulr/api-contract": r("./packages/api-contract/src/index.ts"),
      "@ulr/cost-engine": r("./packages/cost-engine/src/index.ts"),
      "@ulr/cdp-adapter": r("./packages/cdp-adapter/src/index.ts"),
      "@ulr/deck-library": r("./packages/deck-library/src/index.ts"),
      // ⚠ 子路徑要排在根路徑**前面**。Vite 的 alias 是前綴比對
      // （`@ulr/arbiter-link` 也會吃到 `@ulr/arbiter-link/rooms`），排後面的話
      // 會被改寫成 `.../src/index.ts/rooms` 這種不存在的路徑。
      "@ulr/arbiter-link/protocol": r("./packages/arbiter-link/src/protocol.ts"),
      "@ulr/arbiter-link/match-queue": r("./packages/arbiter-link/src/match-queue.ts"),
      "@ulr/arbiter-link/rooms": r("./packages/arbiter-link/src/rooms.ts"),
      "@ulr/arbiter-link": r("./packages/arbiter-link/src/index.ts"),
      "@ulr/arbiter-engine": r("./packages/arbiter-engine/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
});
