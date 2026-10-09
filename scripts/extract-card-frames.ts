/**
 * 重新產生插件內建的空卡框
 * ========================
 * 卡面替換的底稿（`apps/tray/assets/card-frames/`）是這樣來的，遊戲改了卡框時重跑：
 *
 * ```
 *   1. npx tsx scripts/extract-card-frames.ts <CDP 埠>
 *        → 對著跑著的遊戲統計（card-art-extract.ts），寫 168x240/ 的 15 張
 *   2. python scripts/upscale-card-frames.py <模型.pth>
 *        → 用 Real-ESRGAN 動畫模型把 168x240/ 放大成 336x480/
 * ```
 *
 * CDP 埠：桌面版看 `%APPDATA%\UNLIGHT Revive\DevToolsActivePort`（有空格；連字號那個是舊資料夾） 第一行。
 *
 * ⚠ **對戰中不要跑。** 統計在頁面主執行緒上算 7~8 秒，整個遊戲會凍住；
 * 腳本看到戰鬥場景就拒絕。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  CARD_FRAME_EXTRACT_EXPRESSION,
  parseCardFrameExtractResult,
} from "../packages/cdp-adapter/src/card-art-extract.ts";

const port = process.argv[2];
if (port === undefined) {
  console.error("用法：npx tsx scripts/extract-card-frames.ts <CDP 埠>");
  process.exit(1);
}
const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "tray",
  "assets",
  "card-frames",
  "168x240",
);

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}[];
// 2026-09-23 改版後桌面版的遊戲是獨立的 iframe target，外殼 page 上沒有 window.game
const page =
  targets.find((t) => t.type === "iframe" && t.url.includes("playunlight")) ??
  targets.find((t) => t.type === "page");
if (page === undefined) throw new Error("那個埠上沒有頁面");

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((resolve) => ws.once("open", resolve));
let seq = 0;
const waiting = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>();
const contexts: number[] = [];
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id !== undefined) waiting.get(m.id)?.(m);
  if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context.id);
});
function send(method: string, params: object = {}) {
  return new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression: string, contextId: number): Promise<unknown> {
  const r = await send("Runtime.evaluate", { expression, contextId, returnByValue: true });
  return r.result?.result?.value;
}

// 遊戲在 iframe 裡：Runtime.enable 會把每個 context 補送一次，挑有 window.game 的那個
await send("Runtime.enable");
await new Promise((resolve) => setTimeout(resolve, 500));
let ctx: number | null = null;
for (const c of contexts) {
  if ((await evaluate("typeof window.game === 'object' && window.game !== null", c)) === true)
    ctx = c;
}
if (ctx === null) throw new Error("找不到遊戲的 execution context");

const scenes = JSON.parse(
  String(
    await evaluate("JSON.stringify(window.game.scene.getScenes(true).map(s => s.scene.key))", ctx),
  ),
) as string[];
if (scenes.some((k) => /Phase|^Main[AB]$|^Change_/.test(k))) {
  console.error(`✗ 在對戰中（${scenes.join(", ")}），打完再跑`);
  process.exit(1);
}

const result = parseCardFrameExtractResult(
  String(await evaluate(CARD_FRAME_EXTRACT_EXPRESSION, ctx)),
);
ws.close();
if (!result.ok) {
  console.error(`✗ ${result.reason ?? "原因不明"}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const f of result.files) {
  writeFileSync(
    join(outDir, f.name),
    Buffer.from(f.dataUrl.slice(f.dataUrl.indexOf(",") + 1), "base64"),
  );
}
console.log(`✓ ${result.files.length} 張寫進 ${outDir}（頁面算了 ${result.ms} ms）`);
if (result.reason !== null) console.log(`  ⚠ ${result.reason}`);
