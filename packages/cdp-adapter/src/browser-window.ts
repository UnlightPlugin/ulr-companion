/**
 * 把網頁版的瀏覽器視窗調成剛好裝下遊戲畫面
 * ==========================================
 *
 * 頁面自己的 `window.resizeTo` 對一般分頁無效（只對 `window.open` 開出來的
 * 視窗有效），所以由頁面回報「內容區要多大」（`display-window`，見
 * `patch-display.ts`），這裡用 CDP 的 browser 層級命令調：
 *
 * ```
 *   Browser.getWindowForTarget(遊戲分頁)  → windowId、外框 bounds
 *   Browser.setWindowBounds               → 外框 = 外框 + (要的內容區 − 現在的內容區)
 * ```
 *
 * 「外框 − 內容區」就是瀏覽器自己的框（分頁列、網址列、書籤列），每個玩家
 * 不一樣，所以不寫死，每次用回報當下的值算。
 *
 * ⚠ 最大化／最小化的視窗不能直接帶尺寸（CDP 回錯：states cannot be combined
 * with width/height），要先設回 `normal`。全螢幕中不動 —— 那是瀏覽器原生的，
 * 頁面本來就不會在全螢幕時回報。
 *
 * ⚠ 已知限制：瀏覽器本身的縮放（Ctrl + 滾輪）不是 100% 時，頁面的 CSS px 跟
 * 視窗的 DIP 不一樣大，算出來會差一個比例。
 */

import type { DisplayWindowReport } from "./patch-display.js";

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState?: string;
}

export interface BrowserWindowResult {
  ok: boolean;
  /** 調完的外框。沒調是 `null`。 */
  bounds: WindowBounds | null;
  reason: string | null;
}

/**
 * 算出新的外框。純函式。
 *
 * 位置只在「調大之後會跑出工作區」時才移，平常留在玩家放的地方。
 */
export function planBrowserWindow(
  current: WindowBounds,
  report: DisplayWindowReport,
): WindowBounds {
  const width = Math.max(1, Math.round(current.width + (report.width - report.innerWidth)));
  const height = Math.max(1, Math.round(current.height + (report.height - report.innerHeight)));
  const right = report.availLeft + report.availWidth;
  const bottom = report.availTop + report.availHeight;
  const left = Math.max(report.availLeft, Math.min(current.left, right - width));
  const top = Math.max(report.availTop, Math.min(current.top, bottom - height));
  return { left, top, width, height };
}

/** 夠不夠近就不動。差 1px 以內是四捨五入，再調一次只會讓視窗抖一下。 */
export function sameSize(a: WindowBounds, b: WindowBounds): boolean {
  return (
    Math.abs(a.width - b.width) <= 1 &&
    Math.abs(a.height - b.height) <= 1 &&
    a.left === b.left &&
    a.top === b.top
  );
}
