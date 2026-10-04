/**
 * 畫面設定：繪製解析度、畫面大小、全螢幕 ＋ Option 畫面的「plugin」分頁
 * =====================================================================
 *
 * ## 為什麼糊
 *
 * 2026-09-13 實機量（Steam 版 `--force-device-scale-factor=1.5`）：
 *
 * ```
 *   devicePixelRatio      1.5
 *   canvas 繪圖緩衝        760×680      ← Phaser 每一格只畫這麼大
 *   canvas CSS 大小        760×680 CSS px = 1140×1020 螢幕像素
 *   ScaleManager          NONE，game.config 沒有 resolution
 * ```
 *
 * 瀏覽器把 760×680 的點陣圖放大 1.5 倍貼上螢幕，所以糊。網頁版用滾輪放大
 * 一樣糊 —— 放大的是 devicePixelRatio，緩衝還是 760×680。
 *
 * ## ① 繪製解析度：只放大「畫到螢幕」的那一層
 *
 * Phaser 3.87 的 WebGLRenderer 把 viewport、scissor、投影矩陣全都用
 * `renderer.width/height`（邏輯 760×680）算。所以：
 *
 * ```
 *   canvas 緩衝       760×680 → × 倍率
 *   CSS 大小          不動 → 版面、滑鼠座標完全不變
 *   投影矩陣          不動（還是 0..760）
 *   gl.viewport       畫到螢幕（framebuffer null）時 × 倍率
 *   gl.scissor        同上
 *   drawingBuffer*    回報邏輯尺寸（Phaser 拿高度翻 scissor 的 y）
 *   BitmapMask 合成   畫到螢幕時 uResolution × 倍率（見 wrapBitmapMask）
 * ```
 *
 * ⚠ BitmapMask 的 shader 用 `gl_FragCoord.xy / uResolution` 取樣，前者是實際像素。
 * 沒換算的話被遮的東西縮成 1/倍率擠到左下 —— 2026-09-26 回報：長髮（艾茵的髮型）
 * 的頭髮跑到左下、人物變光頭（頭髮有掛遮罩，其他零件沒有）。
 *
 * 遊戲裡的座標、點擊判定、場景程式一個都沒碰。畫到 RenderTexture／濾鏡用的
 * framebuffer 時不縮放（那些有自己的尺寸）。
 *
 * ⚠ 「畫到螢幕」是看**畫的時候**綁的是誰，不是 viewport 呼叫當下 —— Phaser
 * 的 preFX／postFX 管線都先 `gl.viewport` 再 `bindFramebuffer`，所以綁定切換
 * 時要把上次要的值重套（見 `hook()`）。濾鏡精靈本身是先畫進 760×680 的
 * fxTarget 再貼到螢幕，所以有 preFX 的東西（任務地圖的區域與標籤）會跟原版
 * 一樣糊，只是不會消失。
 *
 * 「自動」＝ canvas 實際佔的螢幕像素 ÷ 760×680：`devicePixelRatio × 顯示寬 ÷ 760`。
 * 外殼頁面的 CSS zoom 會傳進 iframe 的 devicePixelRatio（實測 1.25 倍 zoom →
 * iframe 內 dpr 1.5 → 1.875），所以放大畫面、全螢幕都會自動跟上。
 *
 * ### ⚠ 骰子跟 Phaser 共用同一個 GL context
 *
 * 對戰擲骰是 three.js：`new WebGLRenderer({ canvas: this.game.canvas })`，
 * 然後 `setSize(760, 680)` —— 那一行會把 `canvas.width` 設回 760。所以：
 *
 * 1. 縮放倍率**每次呼叫都用「實際緩衝 ÷ 邏輯尺寸」現算**，不是存一個數字。
 * 2. `canvas.width/height` 的 setter 被接住：寫進來的當邏輯尺寸記下，實際緩衝
 *    設成 × 倍率。getter 回邏輯尺寸 —— 遊戲讀到的跟以前一樣。
 * 3. three.js 也是透過同一個 `gl` 物件呼叫 viewport／bindFramebuffer，
 *    所以它的陰影貼圖（framebuffer）不會被縮放，畫到螢幕的那次會。
 *
 * ### 小字：Text 的 resolution 也要跟著補
 *
 * 緩衝放大只救得了「素材本來就比顯示大」的東西。牌組編輯清單上的卡名與
 * HP/ATK/DEF 是 `resolution: 0.6` 的 Text、再縮 0.5 倍顯示 —— 字本身就只畫了
 * 那麼細（2026-09-13 實測 180 個）。所以把文字類別的 `renderWebGL` 包起來：
 * 畫之前量「世界縮放 × 倍率」，不足的排隊、這一格畫完（`postrender`）補到
 * 剛好（以 0.25 為一階）。原值記在物件上，關掉時還原。**不輪詢** —— 換頁、
 * 翻頁新建的字第一格就會被抓到（玩家 2026-09-13 回報輪詢版換頁後又糊）。
 *
 * ## 不輪詢
 *
 * 整支只有「game 還沒建好」時每 500ms 看一次，建好就停。之後全靠事件：
 * canvas.width setter、window resize、Option 場景的 create／shutdown、
 * 貼圖的 addtexture、fullscreenchange。
 *
 * 能清楚多少：卡圖、道具圖示是 2 倍原圖以 0.5 倍顯示 —— 會變清楚。地圖、
 * 面板底圖、按鈕原圖就是等倍 —— 不會。
 *
 * ## ② 畫面大小與全螢幕
 *
 * 桌面版 main.js（2026-09-13 讀的）：`BrowserWindow({ width: 776, height: 719,
 * resizable: false })`，沒有全螢幕、沒有調整視窗的 IPC，但 `webSecurity: false`
 * —— 遊戲 iframe 摸得到外殼頁面。實測：
 *
 * | 手段                         | 結果                                                |
 * | ---------------------------- | --------------------------------------------------- |
 * | 外殼 `window.resizeTo`       | ✓ 可以（視窗不可調整大小也照樣吃）                  |
 * | 外殼 html 的 CSS zoom        | ✓ 傳進 iframe，遊戲整個放大                         |
 * | `requestFullscreen`          | 標題列拿掉、移到 (0,0)，但**視窗大小不變**          |
 * | 全螢幕中 `resizeTo`          | ✗ 被忽略                                            |
 * | 先 `resizeTo` 再全螢幕       | ✗ 只蓋到工作區，工作列還露著（resizeTo 被夾在工作區）|
 * | 全螢幕後由 Node `SetWindowPos`| ✓ 帶 `SWP_NOSENDCHANGING` 才蓋得住工作列             |
 *
 * 所以：畫面大小 ×N ＝ 外殼 zoom N ＋ 視窗內容區調成 760N×680N（剛好是畫面，
 * 不留官方那圈 6／14px 黑邊）；全螢幕 ＝ 頁面
 * `requestFullscreen()`（去框）→ 回報 `display-fullscreen` → Node 用 Win32 把
 * 視窗推成整個螢幕（`window-fill.ts`）→ 外殼收到 resize，zoom 到塞得下、置中。
 * 退出時 Electron 自己把視窗還原，頁面只把 zoom 與 padding 清掉。
 *
 * ⚠ `screen.width/height` 在強制 scale factor 下被多除了一次（實測 3440×1440
 * 螢幕回報 1529×640，availWidth 卻是 2294）。availWidth 大於 width 時用兩者的
 * 比例校正回來。
 *
 * ⚠ 全螢幕要使用者手勢。從下拉選單點的那一下有；插件啟動時照配置補套時沒有
 * —— 那時等玩家在遊戲裡點第一下再進去。
 *
 * ### 2026-09-23 起的桌面版（host "remote"）
 *
 * 遊戲 iframe 變成跨來源的 out-of-process iframe，上面這些外殼操作從 iframe
 * 裡都做不到了。做法不變，改由 Node 另開一條 session 在外殼裡跑 ——
 * 見 shell-display.ts。這支在 remote 時只列下拉清單、回報玩家選了什麼。
 *
 * ### 網頁版（遊戲是頂層頁面）
 *
 * 2026-09-13 實機量（Chrome 152、書籤開的分頁）：
 *
 * | 手段                            | 結果                                                    |
 * | ------------------------------- | ------------------------------------------------------- |
 * | zoom 套在 canvas                | 點擊對，但 rexUI 輸入框（DOM）不跟著放大、位置偏上偏左   |
 * | zoom 套在 html                  | 點擊對、輸入框落在框裡 —— 跟桌面版外殼同一種做法         |
 * | 頁面 `resizeTo`                 | ✗ 一般分頁不吃                                          |
 * | CDP `Browser.setWindowBounds`   | ✓ 由 Node 調（回報 `display-window`）                   |
 *
 * 所以 zoom 套在 html；官方 `style-steam.css` 給 body 的 `padding: 50px`、
 * 置中（`justify-items: center`）與預設 8px margin 清掉，畫面貼齊左上角、
 * 底色黑，視窗調成剛好 760N×680N。全螢幕是瀏覽器原生的，置中跟桌面版一樣用
 * body padding。
 *
 * ⚠ 量點擊時要等 Phaser 重算 `displayScale`（它自己每 500ms 看一次 canvas
 * 大小）—— 換完 zoom 立刻送滑鼠事件會量到還沒更新的值，看起來像點擊偏了。
 *
 * ## ③ plugin 分頁
 *
 * Option 的分頁鈕是 `option_category` 圖集（96×22 × 3 狀態 `out/over/up`，`up` 是
 * 選中），字烤在圖上，只有 volume／language／profile。這三個字的字母拼得出
 * **plugin**，所以從圖集切字母拼一格出來，加到同一張貼圖的第二個 source 上，frame
 * 名稱 `plugin_out/over/up`。
 *
 * 2026-09-23 改版前是 `option_cate_btn` 圖集＋場景上的 `CATEGORY` 表，加一項官方
 * 就會建鈕、切換。**改版後分頁清單是模組私有陣列**（`h.zv`，摸不到），所以鈕要
 * 自己建（`create` 事件之後，x = 96 × 官方分頁數）。好在切換是用名字呼叫的：
 *
 * ```
 *   官方鈕 pointerup：其他官方鈕設回 _out → this["destroy_" + this.category]()
 *                     → 自己設 _up → this.category = t → this["show_" + t]()
 * ```
 *
 * 所以在場景**實例**上放 `show_plugin`／`destroy_plugin`，從 plugin 切走時官方
 * 程式碼自己會呼叫 `destroy_plugin`（我們在裡面收內容、把鈕設回 `_out`）；我們的
 * 鈕照同一套順序切進來。`init()` 每次都把 `category` 設回第一個，不會卡在 plugin。
 *
 * 分頁內容照抄官方：高解析度那列是 profile 分頁的勾選列（字＋15×15 白框黑勾）；
 * 畫面大小是 language 分頁的下拉（`btn_gene` 按鈕＋黑字、rexUI scrollablePanel
 * 清單，白底、hover 紅框粉底）；「自訂」打開的輸入框是 profile 的簡介框
 * （rexUI textEdit）。
 *
 * ## 這支的真相在頁面上
 *
 * 切換只影響這個頁面怎麼畫，所以選下去**頁面自己就套用**，再回報
 * `display-settings` 讓 Node 存進配置。Node 推回來的狀態蓋過頁面的。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。**
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrDisplay";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**。 */
export const DISPLAY_SCRIPT_VERSION = 12;

export const DEFAULT_DISPLAY_POLL_MS = 500;

/** 繪圖緩衝倍率上限。再往上是 760×680 的十幾倍，GPU 吃不消又看不出差別。 */
export const MAX_RENDER_SCALE = 4;

/**
 * 解析度只有開／關。`auto` = 照畫面實際佔的螢幕像素畫（devicePixelRatio ×
 * 畫面放大倍率）。固定 ×2／×3 玩家 2026-09-13 說「沒意義，只有開關才有意義」。
 */
export const RENDER_MODES = ["off", "auto"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** 下拉選單列出來的倍率。自訂輸入的倍率也是 `x<數字>` 這個形狀。 */
export const SIZE_PRESETS = ["x1", "x1.25", "x1.5", "x1.75", "x2"] as const;
/**
 * 畫面放大倍率的上下限。自訂輸入**只**夾在這裡面 —— 不夾工作區（玩家 2026-09-13
 * 定）；桌面版塞不進工作區的部分會被 Chromium 切掉，下拉清單則只列塞得進的。
 *
 * 下限開到 0.5（玩家 2026-09-15 要求可以縮小）。預設清單不列小於 1 的，要打自訂。
 * 網頁版瀏覽器視窗有最小寬度，縮太小時視窗會比畫面大、右邊留黑。
 */
export const MIN_SIZE_ZOOM = 0.5;
export const MAX_SIZE_ZOOM = 4;
export type SizeMode = `x${number}` | "fullscreen";

export function isRenderMode(value: unknown): value is RenderMode {
  return (RENDER_MODES as readonly unknown[]).includes(value);
}

/** `"x1"`、`"x1.75"`、`"x0.8"`（0.5〜4）或 `"fullscreen"`。 */
export function isSizeMode(value: unknown): value is SizeMode {
  if (value === "fullscreen") return true;
  if (typeof value !== "string" || !/^x\d+(\.\d+)?$/.test(value)) return false;
  const n = Number(value.slice(1));
  return n >= MIN_SIZE_ZOOM && n <= MAX_SIZE_ZOOM;
}

/** Node 推給頁面的狀態，也是托盤存進配置的東西。 */
export interface DisplayState {
  render: RenderMode;
  size: SizeMode;
}

/** 預設開高解析度：不放大時它等於沒開，放大時才有差，沒有副作用。 */
export const DEFAULT_DISPLAY_STATE: DisplayState = { render: "auto", size: "x1" };

/** 玩家在 Option 的 plugin 分頁改了設定（頁面已經自己套用了）。 */
export interface DisplaySettingsReport {
  type: "display-settings";
  render: RenderMode;
  size: SizeMode;
}

export function isDisplaySettingsReport(value: unknown): value is DisplaySettingsReport {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return o["type"] === "display-settings" && isRenderMode(o["render"]) && isSizeMode(o["size"]);
}

/**
 * 頁面進了／出了 HTML 全螢幕。桌面版 `active: true` 之後 Node 要把視窗推滿
 * 螢幕（`window-fill.ts`）—— 頁面自己做不到，理由見那個檔頭。
 */
export interface DisplayFullscreenReport {
  type: "display-fullscreen";
  active: boolean;
  host: "desktop" | "web";
}

export function isDisplayFullscreenReport(value: unknown): value is DisplayFullscreenReport {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    o["type"] === "display-fullscreen" &&
    typeof o["active"] === "boolean" &&
    (o["host"] === "desktop" || o["host"] === "web")
  );
}

/**
 * 網頁版要把瀏覽器視窗調成剛好裝下畫面。頁面自己的 `resizeTo` 對一般分頁
 * 無效（只對 `window.open` 開的視窗有效），所以回報給 Node，由 CDP 的
 * `Browser.setWindowBounds` 調（見 `browser-window.ts`）。
 *
 * 單位都是頁面的 CSS px。`innerWidth/innerHeight` 是**回報當下**的內容區，
 * Node 拿「視窗外框 − 內容區」算出瀏覽器自己的框（分頁列、網址列）有多厚。
 */
export interface DisplayWindowReport {
  type: "display-window";
  /** 想要的內容區：760×倍率、680×倍率。 */
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  /** 工作區（DIP）。調大之後別讓視窗跑出去。 */
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}

export function isDisplayWindowReport(value: unknown): value is DisplayWindowReport {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (o["type"] !== "display-window") return false;
  const nums = [
    "width",
    "height",
    "innerWidth",
    "innerHeight",
    "availLeft",
    "availTop",
    "availWidth",
    "availHeight",
  ];
  return nums.every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));
}

export interface DisplayStatus {
  installed: boolean;
  version: number | null;
  state: DisplayState | null;
  /** 現在實際套用的繪圖倍率。沒放大是 1，沒裝是 `null`。 */
  scale: number | null;
  /** 實際的繪圖緩衝，例如 `"1140x1020"`。遊戲還沒起來是 `null`。 */
  buffer: string | null;
  /**
   * 桌面版（外殼頁面摸得到）還是網頁版。還沒判斷是 `null`。
   *
   * `remote` ＝ 2026-09-23 起的桌面版：遊戲 iframe 在自己的程序、跨來源，
   * 摸不到外殼 —— 畫面大小／全螢幕做不了，只剩解析度。
   */
  host: "desktop" | "web" | "remote" | null;
  /** 現在套用的畫面縮放。 */
  zoom: number | null;
  fullscreen: boolean;
  /** 全螢幕在等玩家點一下（沒有使用者手勢進不去）。 */
  fullscreenPending: boolean;
  /** 補過 resolution、目前還活著的文字物件數。 */
  texts: number;
  /** plugin 分頁鈕的 frame 做出來了沒。 */
  tab: boolean;
  /** 字母是從圖集拼的（true）還是退回文字畫的（false）。沒做出來是 `null`。 */
  glyphs: boolean | null;
  /** 分頁內容畫在 Option 畫面上了沒。 */
  mounted: boolean;
  reason: string | null;
}

export interface DisplayPatchOptions {
  bindingName: string;
  state: DisplayState;
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// 文案 —— 照官方 language 分頁的五種語言
// ---------------------------------------------------------------------------

/** 分頁標題（左上 (8,64)，官方是「音量設定」「簡介設定」那一行）。 */
const TAB_TITLE: Record<string, string> = {
  ja: "プラグイン設定",
  en: "Plugin Settings",
  kr: "플러그인 설정",
  scn: "插件设定",
  tcn: "插件設定",
};

/** 勾選框左邊的字（照 profile 分頁「顯示最後上線時間 ☐」那一列）。≤8 字。 */
const RENDER_LABEL: Record<string, string> = {
  ja: "高解像度",
  en: "High Resolution",
  kr: "고해상도",
  scn: "高分辨率",
  tcn: "高解析度",
};

const SIZE_LABEL: Record<string, string> = {
  ja: "画面サイズ",
  en: "Screen Size",
  kr: "화면 크기",
  scn: "画面大小",
  tcn: "畫面大小",
};

const RENDER_TIP: Record<string, string> = {
  ja: "実際の表示サイズで描画し、文字と縮小表示の画像を鮮明にします",
  en: "Render at the real on-screen size for sharper text and art",
  kr: "실제 표시 크기로 그려 글자와 이미지를 선명하게 합니다",
  scn: "按实际显示大小绘制，文字与缩小显示的图片更清晰",
  tcn: "依實際顯示大小繪製，文字與縮小顯示的圖片更清楚",
};

const SIZE_TIP: Record<string, string> = {
  ja: "ゲーム画面全体を拡大します。全画面は Esc で戻ります",
  en: "Enlarge the whole game. Press Esc to leave fullscreen",
  kr: "게임 화면 전체를 확대합니다. 전체 화면은 Esc로 나갑니다",
  scn: "放大整个游戏画面；全屏按 Esc 离开",
  tcn: "放大整個遊戲畫面；全螢幕按 Esc 離開",
};

/** 下拉選單裡「自訂」那一項的值 —— 不是 SizeMode，選了是打開輸入框。 */
const CUSTOM_OPTION = "custom";

const SIZE_OPTIONS: {
  value: SizeMode | typeof CUSTOM_OPTION;
  label: Record<string, string> | string;
}[] = [
  ...SIZE_PRESETS.map((value) => ({ value, label: `×${value.slice(1)}` })),
  {
    value: CUSTOM_OPTION,
    label: { ja: "カスタム", en: "Custom", kr: "커스텀", scn: "自定义", tcn: "自訂" },
  },
  {
    value: "fullscreen",
    label: { ja: "全画面", en: "Fullscreen", kr: "전체 화면", scn: "全屏", tcn: "全螢幕" },
  },
];

/**
 * 版面。勾選框那列照 profile 分頁：字 font_light 15 原點 (.5,.5)，框 15×15 在字的
 * 右邊 +5。下拉照 language 分頁：說明字 (380,200) 原點 (.5,0)、按鈕 (380,250)、
 * 清單在按鈕下 14px、每列 24px、寬 76。自訂輸入框照 profile 的簡介框：白底
 * 0.7、框線 1、黑字，放在按鈕右邊。
 */
const LAYOUT = {
  x: 380,
  renderY: 150,
  checkGap: 5,
  checkSize: 15,
  sizeLabelY: 215,
  sizeButtonY: 260,
  /** 自訂輸入框：按鈕右緣到框左緣的距離、框寬高。 */
  inputGap: 12,
  inputW: 60,
  inputH: 22,
  /** 說明浮在標題上方多遠。 */
  tipGap: 6,
};

/**
 * 字烤在圖裡的按鈕，高解析度時用遊戲字型重畫一張 K 倍的來源（btn_use、raid_code）。
 *
 * 2026-09-13 回報「使用也要變清楚」：物品欄的 `btn_use` 是 80×24 的點陣圖、字畫在
 * 圖裡，原圖就只有 1 倍 —— 緩衝放大、補 resolution 都救不了。實機量過的構造：
 *
 * ```
 *   圖集 320×48，一列 4 格：ja「使用する」、en/kr「Use」（同一格）、scn「使用」、tcn「使用」
 *   上一列 _1 常態：底 #016285、字 #b6b6b6、深色陰影
 *   下一列 _2 hover：底 #01b2f1、字 #fcfeff、青色光暈 #38fdff
 *   四角各缺 1px，底色水平一致（每一列只有一個顏色）
 * ```
 *
 * 重畫法：底照原圖（內部每一列拿 x=2 那一格的顏色塗滿，把字抹掉；角落照抄），字用
 * 遊戲自己的 font_bold（跟原圖並排比過四種字型，這個最像）。字型、顏色都是遊戲的。
 */
const HD_BUTTONS = [
  {
    key: "btn_use",
    cellW: 80,
    cellH: 24,
    /** 格子左上角 x → 字。en 與 kr 共用一格。這張圖四種語言排在同一列。 */
    labels: { "0": "使用する", "80": "Use", "160": "使用", "240": "使用" } as Record<
      string,
      string
    >,
    langLabels: null as Record<string, string> | null,
    /** 格子裡要蓋掉字的範圍 [x0, y0, x1, y1]（含），與拿來鋪的直條 [x0, x1)。單色底，1px 就夠。 */
    interior: [3, 3, 76, 20],
    strip: [2, 3],
    textX: 40,
    textY: 12.5,
    font: "font_bold",
    fontSize: 13,
    /** 第二列（y ≥ cellH）是 hover。 */
    normal: { color: "#b6b6b6", shadow: "#01405e", blur: 2, offset: 0.5, passes: 1 },
    hover: { color: "#fcfeff", shadow: "#38fdff", blur: 4, offset: 0, passes: 3 },
  },
  {
    /**
     * 渦房左下「輸入Raid代碼」（128×24 兩格：常態、hover）。石紋底加 1px 亮邊、下方陰影。
     * ⚠ 這張圖**只有一種語言的字**，是照遊戲語言載的 —— 只有實機看過字的語言才重畫，
     * 其他語言維持原圖（寫錯字比糊更糟）。
     */
    key: "raid_code",
    cellW: 128,
    cellH: 24,
    labels: null as Record<string, string> | null,
    langLabels: { tcn: "輸入Raid代碼" } as Record<string, string> | null,
    /** 字左邊 x=4..21 那段沒有字，鋪過去；石紋是直向漸層，橫向鋪看不出接縫。 */
    interior: [3, 3, 124, 18],
    strip: [4, 22],
    textX: 64,
    textY: 11.5,
    font: "font_bold",
    fontSize: 11,
    normal: { color: "#e3e3e3", shadow: "#141619", blur: 1.5, offset: 0.7, passes: 2 },
    hover: { color: "#ffffff", shadow: "#1c2029", blur: 1.5, offset: 0.7, passes: 2 },
  },
];

export function buildDisplayPatchScript(options: DisplayPatchOptions): string {
  const config = {
    hdButtons: HD_BUTTONS,
    version: DISPLAY_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_DISPLAY_POLL_MS,
    state: options.state,
    maxScale: MAX_RENDER_SCALE,
    minZoom: MIN_SIZE_ZOOM,
    maxZoom: MAX_SIZE_ZOOM,
    customOption: CUSTOM_OPTION,
    tabTitle: TAB_TITLE,
    renderLabel: RENDER_LABEL,
    sizeLabel: SIZE_LABEL,
    renderTip: RENDER_TIP,
    sizeTip: SIZE_TIP,
    sizeOptions: SIZE_OPTIONS,
    layout: LAYOUT,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var L = CFG.layout;
  var FLAG = ${JSON.stringify(FLAG)};
  var TAB_KEY = "option_category";
  var TAB = "plugin";
  var STATES = ["out", "over", "up"];
  var DATA_ZOOM = "data-ulr-zoom";

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {}
  }

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function pick(table) {
    if (typeof table === "string") return table;
    return table[gameLang()] || table.en;
  }

  function alive(o) {
    return !!(o && o.scene);
  }

  function fail(e) {
    st.reason = String((e && e.message) || e);
  }

  // 先拆再裝
  try {
    // keepWindow：視窗與全螢幕留給新實例接手，不要在這裡動（動了新實例會量到
    // 移動中的視窗，邊框算錯）。
    if (window[FLAG] && typeof window[FLAG].uninstall === "function") window[FLAG].uninstall({ keepWindow: true });
  } catch (e) {}

  var st = {
    version: CFG.version,
    state: CFG.state,
    reason: null,
    timer: null,
    hook: null,
    texts: [],
    pending: [],
    /** 換過來源的烤字按鈕：key → { source, orig, k }（見 syncHdButtons）。 */
    hd: {},
    wrapped: [],
    addHooks: [],
    postRender: null,
    game: null,
    sceneHooks: null,
    shellWin: null,
    frame: null,
    /** 勾選框由程式設值時不要當成玩家點的。 */
    silent: false,
    /** 選了「自訂」→ 輸入框亮著。 */
    customOpen: false,
    host: null,
    zoom: 1,
    fullscreen: false,
    fsPending: false,
    fsLeaving: false,
    fsListener: null,
    fsClick: null,
    lastSize: "x1",
    tex: null,
    texSource: null,
    glyphs: null,
    texListener: null,
    texManager: null,
    page: null,
    setState: null,
    uninstall: null
  };

  // =========================================================================
  // ① 繪圖緩衝放大
  // =========================================================================

  function findDescriptor(obj, name) {
    var p = obj;
    while (p) {
      var d = Object.getOwnPropertyDescriptor(p, name);
      if (d) return d;
      p = Object.getPrototypeOf(p);
    }
    return null;
  }

  function logicalSize(g) {
    if (st.hook && st.hook.canvas === g.canvas) return { w: st.hook.logicalW, h: st.hook.logicalH };
    return { w: g.canvas.width, h: g.canvas.height };
  }

  /** canvas 實際佔的螢幕像素 ÷ 邏輯像素。 */
  function density(g) {
    var dpr = Number(window.devicePixelRatio) || 1;
    try {
      var r = g.canvas.getBoundingClientRect();
      var s = logicalSize(g);
      if (r.width > 0 && r.height > 0 && s.w > 0 && s.h > 0) return dpr * Math.min(r.width / s.w, r.height / s.h);
    } catch (e) {}
    return dpr;
  }

  function wantedScale(g) {
    if (st.state.render !== "auto") return 1;
    var s = Math.round(Math.min(CFG.maxScale, density(g)) * 100) / 100;
    return s <= 1.01 ? 1 : s;
  }

  function hook(g) {
    var r = g.renderer;
    var gl = r && r.gl;
    var canvas = g.canvas;
    if (!gl || !canvas || gl.canvas !== canvas) return null;

    // 從原型找：實例上的屬性可能是別人（或上一版沒拆乾淨的自己）包過的。
    var CW = findDescriptor(Object.getPrototypeOf(canvas), "width");
    var CH = findDescriptor(Object.getPrototypeOf(canvas), "height");
    var DBW = findDescriptor(Object.getPrototypeOf(gl), "drawingBufferWidth");
    var DBH = findDescriptor(Object.getPrototypeOf(gl), "drawingBufferHeight");
    if (!CW || !CH || !CW.set || !CH.set || !DBW || !DBH) return null;
    var P = Object.getPrototypeOf(gl);

    var h = {
      g: g, r: r, gl: gl, canvas: canvas,
      CW: CW, CH: CH,
      logicalW: CW.get.call(canvas),
      logicalH: CH.get.call(canvas),
      scale: 1,
      cur: null,
      vp: null,
      sc: null,
      styleW: null,
      styleH: null
    };
    try { h.cur = gl.getParameter(gl.FRAMEBUFFER_BINDING) || null; } catch (e) { h.cur = null; }
    // 裝上時倍率是 1，GL 現在的值就是邏輯值。
    try { h.vp = Array.prototype.slice.call(gl.getParameter(gl.VIEWPORT)); } catch (e) { h.vp = null; }
    try { h.sc = Array.prototype.slice.call(gl.getParameter(gl.SCISSOR_BOX)); } catch (e) { h.sc = null; }

    function sx() { return h.logicalW > 0 ? CW.get.call(canvas) / h.logicalW : 1; }
    function sy() { return h.logicalH > 0 ? CH.get.call(canvas) / h.logicalH : 1; }

    // viewport／scissor 記「遊戲要的邏輯值」，畫到螢幕時才乘倍率。
    //
    // ⚠ 不能在呼叫當下看目前綁的是誰就決定：Phaser 的 FxPipeline（preFX）、
    // PostFXPipeline、UtilityPipeline.copyFrame 都是**先 gl.viewport 再
    // bindFramebuffer**。2026-09-13 實測：任務地圖的區域高亮與標籤（preFX
    // 的 colorMatrix）整個消失 —— viewport 被乘了倍率才綁到 760×680 的
    // fxTarget，精靈畫到了 copyTexSubImage2D 抓的範圍外面。所以綁定在
    // 「螢幕 ↔ framebuffer」之間切換時，把上次要的值照新目標重套一次。
    function applyViewport() {
      var v = h.vp;
      if (!v) return;
      if (h.cur !== null) return P.viewport.call(gl, v[0], v[1], v[2], v[3]);
      var a = sx(), b = sy();
      return P.viewport.call(gl, Math.round(v[0] * a), Math.round(v[1] * b), Math.round(v[2] * a), Math.round(v[3] * b));
    }
    function applyScissor() {
      var v = h.sc;
      if (!v) return;
      if (h.cur !== null) return P.scissor.call(gl, v[0], v[1], v[2], v[3]);
      var a = sx(), b = sy();
      var x0 = Math.floor(v[0] * a), y0 = Math.floor(v[1] * b);
      return P.scissor.call(gl, x0, y0, Math.ceil((v[0] + v[2]) * a) - x0, Math.ceil((v[1] + v[3]) * b) - y0);
    }

    var FRAMEBUFFER = gl.FRAMEBUFFER;
    var DRAW_FRAMEBUFFER = 0x8CA9;
    gl.bindFramebuffer = function (target, fb) {
      var out = P.bindFramebuffer.call(gl, target, fb);
      if (target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER) {
        var next = fb || null;
        var switched = (next === null) !== (h.cur === null);
        h.cur = next;
        if (switched) { applyViewport(); applyScissor(); }
      }
      return out;
    };
    gl.viewport = function (x, y, w, hh) {
      h.vp = [x, y, w, hh];
      return applyViewport();
    };
    gl.scissor = function (x, y, w, hh) {
      h.sc = [x, y, w, hh];
      return applyScissor();
    };
    Object.defineProperty(gl, "drawingBufferWidth", {
      configurable: true,
      get: function () { return Math.round(DBW.get.call(gl) / sx()); }
    });
    Object.defineProperty(gl, "drawingBufferHeight", {
      configurable: true,
      get: function () { return Math.round(DBH.get.call(gl) / sy()); }
    });
    Object.defineProperty(canvas, "width", {
      configurable: true,
      get: function () { return h.logicalW; },
      set: function (v) {
        h.logicalW = Math.max(0, Math.floor(Number(v) || 0));
        CW.set.call(canvas, Math.round(h.logicalW * h.scale));
      }
    });
    Object.defineProperty(canvas, "height", {
      configurable: true,
      get: function () { return h.logicalH; },
      set: function (v) {
        h.logicalH = Math.max(0, Math.floor(Number(v) || 0));
        CH.set.call(canvas, Math.round(h.logicalH * h.scale));
      }
    });

    // 緩衝放大後 CSS 大小一定要釘住，否則畫面會跟著緩衝變大。
    if (canvas.style) {
      if (!canvas.style.width) { h.styleW = ""; canvas.style.width = h.logicalW + "px"; }
      if (!canvas.style.height) { h.styleH = ""; canvas.style.height = h.logicalH + "px"; }
    }
    wrapBitmapMask(h, sx, sy);
    return h;
  }

  // BitmapMask 合回螢幕那一下：shader 用 gl_FragCoord.xy / uResolution 取樣，
  // gl_FragCoord 是實際像素、uResolution 卻是邏輯 760x680 —— 放大 K 倍時被遮的
  // 東西縮成 1/K 擠到左下（2026-09-26 回報：長髮的頭髮跑到左下、人物光頭）。
  // 畫到螢幕（沒綁 framebuffer）時把送進去的 uResolution 乘上倍率；
  // endMask 畫完自己設回邏輯值的那一下不動。
  function wrapBitmapMask(h, sx, sy) {
    var pm = h.r.pipelines;
    var bm = null;
    try { bm = pm && typeof pm.get === "function" ? pm.get("BitmapMaskPipeline") : null; } catch (e) { bm = null; }
    if (!bm || typeof bm.endMask !== "function" || typeof bm.set2f !== "function") return;
    var hadOwn = Object.prototype.hasOwnProperty.call(bm, "endMask");
    var orig = bm.endMask;
    bm.endMask = function (mask, gameObject, camera) {
      var self = this;
      var set2f = self.set2f;
      var hadOwnSet = Object.prototype.hasOwnProperty.call(self, "set2f");
      var first = true;
      self.set2f = function (name, x, y) {
        if (first && name === "uResolution" && h.cur === null) {
          first = false;
          var a = sx(), b = sy();
          var args = Array.prototype.slice.call(arguments);
          args[1] = x * a;
          args[2] = y * b;
          return set2f.apply(this, args);
        }
        return set2f.apply(this, arguments);
      };
      try {
        // 沒給 camera 時官方不設 uResolution（沿用邏輯值）—— 補一個同尺寸的，讓上面換算得到
        return orig.call(self, mask, gameObject, camera || { width: self.width, height: self.height });
      } finally {
        if (hadOwnSet) self.set2f = set2f; else delete self.set2f;
      }
    };
    h.mask = { pipe: bm, orig: orig, hadOwn: hadOwn };
  }

  function unwrapBitmapMask(h) {
    var m = h && h.mask;
    if (!m) return;
    try {
      if (m.hadOwn) m.pipe.endMask = m.orig;
      else delete m.pipe.endMask;
    } catch (e) {}
    h.mask = null;
  }

  function setScale(h, s) {
    h.scale = s;
    var w = Math.round(h.logicalW * s), hh = Math.round(h.logicalH * s);
    if (h.CW.get.call(h.canvas) !== w) h.CW.set.call(h.canvas, w);
    if (h.CH.get.call(h.canvas) !== hh) h.CH.set.call(h.canvas, hh);
    // 緩衝一換 viewport 就要重設；resize 用的是邏輯尺寸，縮放交給上面的 gl.viewport。
    try { h.r.resize(h.r.width, h.r.height); } catch (e) {}
  }

  function unhook(h) {
    if (!h) return;
    var gl = h.gl, canvas = h.canvas;
    unwrapBitmapMask(h);
    try { delete gl.bindFramebuffer; } catch (e) {}
    try { delete gl.viewport; } catch (e) {}
    try { delete gl.scissor; } catch (e) {}
    try { delete gl.drawingBufferWidth; } catch (e) {}
    try { delete gl.drawingBufferHeight; } catch (e) {}
    try { delete canvas.width; } catch (e) {}
    try { delete canvas.height; } catch (e) {}
    try { h.CW.set.call(canvas, h.logicalW); } catch (e) {}
    try { h.CH.set.call(canvas, h.logicalH); } catch (e) {}
    try {
      if (h.styleW !== null) canvas.style.width = h.styleW;
      if (h.styleH !== null) canvas.style.height = h.styleH;
    } catch (e) {}
    try { h.r.resize(h.r.width, h.r.height); } catch (e) {}
  }

  function syncRender() {
    var g = window.game;
    if (st.hook && (!g || st.hook.g !== g || st.hook.r !== g.renderer || st.hook.canvas !== g.canvas)) {
      unhook(st.hook);
      st.hook = null;
    }
    if (!g || !g.renderer || !g.canvas) return;
    var want = wantedScale(g);
    if (want === 1) {
      if (st.hook) { unhook(st.hook); st.hook = null; }
      return;
    }
    if (!st.hook) {
      st.hook = hook(g);
      if (!st.hook) { st.reason = "不是 WebGL，或讀不到 canvas／GL 的屬性"; return; }
    }
    var h = st.hook;
    if (h.scale !== want || h.CW.get.call(h.canvas) !== Math.round(h.logicalW * want)) setScale(h, want);
  }

  function currentScale() {
    return st.hook ? st.hook.scale : 1;
  }

  function bufferText() {
    var g = window.game;
    if (!g || !g.canvas) return null;
    try {
      var CW = findDescriptor(Object.getPrototypeOf(g.canvas), "width");
      var CH = findDescriptor(Object.getPrototypeOf(g.canvas), "height");
      return CW.get.call(g.canvas) + "x" + CH.get.call(g.canvas);
    } catch (e) { return null; }
  }

  // -------------------------------------------------------------------------
  // 小字的 resolution —— 掛在文字類別的 renderWebGL 上，不輪詢
  //
  // 畫之前量「世界縮放 × 倍率」，不夠就排隊；在這一格畫完（game 的
  // postrender）才 setResolution。不在 renderWebGL 裡直接換：那會在批次
  // 畫到一半時上傳貼圖、動到綁定中的 texture unit。代價是新建的字第一格
  // 還是舊的解析度（16ms，看不出來）。
  // -------------------------------------------------------------------------

  function isTextLike(o) {
    return !!(o && o.style && typeof o.setResolution === "function" && typeof o.renderWebGL === "function");
  }

  function wrapTextProto(proto) {
    if (!proto || typeof proto.renderWebGL !== "function") return;
    if (Object.prototype.hasOwnProperty.call(proto, "__ulrRenderWebGL")) return;
    var hadOwn = Object.prototype.hasOwnProperty.call(proto, "renderWebGL");
    var orig = proto.renderWebGL;
    proto.__ulrRenderWebGL = orig;
    proto.renderWebGL = function (renderer, src, camera, parentMatrix) {
      var t = src || this;
      try { checkText(t, camera, parentMatrix); } catch (e) {}
      var k = croppedBoost(t);
      if (k === 1) return orig.apply(this, arguments);
      // 裁切過的字：畫的這一下把裁切框換成畫布像素、縮放倒過來補，畫完原樣還原。
      var c = t._crop, ox = t._displayOriginX, oy = t._displayOriginY, sx = t._scaleX, sy = t._scaleY;
      var cx = c.x, cy = c.y, cw = c.width, ch = c.height;
      c.x = cx * k; c.y = cy * k; c.width = cw * k; c.height = ch * k;
      t._displayOriginX = ox * k; t._displayOriginY = oy * k;
      t._scaleX = sx / k; t._scaleY = sy / k;
      try {
        return orig.apply(this, arguments);
      } finally {
        c.x = cx; c.y = cy; c.width = cw; c.height = ch;
        t._displayOriginX = ox; t._displayOriginY = oy;
        t._scaleX = sx; t._scaleY = sy;
      }
    };
    st.wrapped.push({ proto: proto, orig: orig, hadOwn: hadOwn });
  }

  function unwrapTextProtos() {
    for (var i = st.wrapped.length - 1; i >= 0; i--) {
      var w = st.wrapped[i];
      try {
        if (w.hadOwn) w.proto.renderWebGL = w.orig;
        else delete w.proto.renderWebGL;
        delete w.proto.__ulrRenderWebGL;
      } catch (e) {}
    }
    st.wrapped = [];
  }

  function matrixScale(m) {
    return Math.max(Math.sqrt(m.a * m.a + m.b * m.b), Math.sqrt(m.c * m.c + m.d * m.d));
  }

  /**
   * 裁切過的字被我們補了幾倍解析度（沒補、沒裁切 → 1）。
   *
   * ⚠ Phaser 3.87 的 batchTexture 畫 crop 過的物件時，拿 _crop.x/width **當畫布
   * 像素取 UV**，又拿**同一組數字當四邊形大小**（物件單位）。解析度 1 時兩者相等；
   * 補到 2 就變成「取左上 1/4 的畫布、畫成原本大小」＝兩倍大的字（2026-09-13 回報
   * 物品欄「效果」變太大，那格是 rexUI textArea，內文靠 crop 捲動）。只跳過不補的話
   * 它又糊（同日回報）。
   *
   * 所以畫的那一下：crop ×k（變回畫布像素）、displayOrigin ×k、scale ÷k —— 四邊形
   * 經過縮放後大小與位置跟原本一模一樣，取樣的卻是 k 倍的畫布。畫完還原，
   * rexUI 自己讀到的 crop 永遠是它寫進去的那組數字。
   * 用「現在 ÷ 原值」而不是現在的解析度：官方本來就不是 1 的，保持官方原樣。
   */
  function croppedBoost(t) {
    if (!t || !t.isCropped || !t._crop || !t.style || t.__ulrRes0 === undefined) return 1;
    var k = (t.style.resolution || 1) / (t.__ulrRes0 || 1);
    return k > 1 ? k : 1;
  }

  function checkText(src, camera, parentMatrix) {
    if (!src || !src.style) return;
    var scale = currentScale();
    var original = src.__ulrRes0;
    if (scale <= 1 && original === undefined) return;
    var want = 0;
    // 被 setCrop 過的字也補，但畫的時候要換算，見 croppedBoost。
    if (scale > 1) {
      var ws = Math.max(Math.abs(src.scaleX || 0), Math.abs(src.scaleY || 0));
      if (parentMatrix) ws *= matrixScale(parentMatrix);
      if (camera && camera.zoom) ws *= camera.zoom;
      if (ws > 0) want = Math.min(CFG.maxScale, Math.ceil(ws * scale * 4) / 4);
    }
    var cur = src.style.resolution || 1;
    var target = original === undefined ? want : Math.max(original, want);
    var needed = original === undefined ? want > cur : target !== cur;
    if (!needed || src.__ulrPending === target) return;
    src.__ulrPending = target;
    st.pending.push(src);
  }

  // -------------------------------------------------------------------------
  // 字烤在圖裡的按鈕（HD_BUTTONS）：換成 K 倍重畫的來源
  //
  // TextureSource 的 width/height 維持原值 —— UV 是拿 cut ÷ source.width 算的，
  // 四邊形大小是 cutWidth，兩個都不變；只有 GL 貼圖本身換成 K 倍的畫布。遊戲 hover
  // 時 setTexture("btn_use", "tcn_2") 照舊走同一個 Texture，不必碰任何按鈕物件。
  // 在 postrender 換（跟文字一樣），不要在批次畫到一半時換掉綁著的貼圖。
  // -------------------------------------------------------------------------

  function hdFactor() {
    var s = currentScale();
    return s > 1 ? Math.min(CFG.maxScale, Math.ceil(s)) : 1;
  }

  /** 這一個語言有沒有字可畫。只給 langLabels 的圖（單一語言的圖）才可能沒有。 */
  function hdLabelReady(spec, lang) {
    return !spec.langLabels || typeof spec.langLabels[lang] === "string";
  }

  /**
   * 畫一張 K 倍的來源。每一格：底照原圖、內部用「沒有字的那段直條」（spec.strip）
   * 橫向鋪滿把字蓋掉，整張平滑放大（跟 GPU 原本線性放大的樣子一樣），字用遊戲字型
   * 畫在 K 倍上。石紋底（raid_code）靠鋪直條，單色底（btn_use）的直條寬 1px。
   */
  function drawHdButton(spec, img, K, lang) {
    var W = img.width, H = img.height, cw = spec.cellW, ch = spec.cellH;
    var byLang = spec.langLabels ? spec.langLabels[lang] : null;
    var base = document.createElement("canvas");
    base.width = W; base.height = H;
    var b = base.getContext("2d");
    b.drawImage(img, 0, 0);
    var r = spec.interior, s = spec.strip, sw = s[1] - s[0], rh = r[3] - r[1] + 1;
    for (var cy = 0; cy + ch <= H; cy += ch) {
      for (var cx = 0; cx + cw <= W; cx += cw) {
        for (var x = r[0]; x <= r[2]; x += sw) {
          var w = Math.min(sw, r[2] - x + 1);
          b.drawImage(base, cx + s[0], cy + r[1], w, rh, cx + x, cy + r[1], w, rh);
        }
      }
    }
    var hd = document.createElement("canvas");
    hd.width = W * K; hd.height = H * K;
    var h = hd.getContext("2d");
    h.imageSmoothingEnabled = true;
    h.imageSmoothingQuality = "high";
    h.drawImage(base, 0, 0, W * K, H * K);
    for (var cy2 = 0; cy2 + ch <= H; cy2 += ch) {
      for (var cx2 = 0; cx2 + cw <= W; cx2 += cw) {
        var label = typeof byLang === "string" ? byLang : spec.labels && spec.labels[String(cx2)];
        if (typeof label !== "string") continue;
        var look = cy2 >= ch ? spec.hover : spec.normal;
        h.save();
        h.font = (spec.fontSize * K) + "px " + spec.font;
        h.textAlign = "center";
        h.textBaseline = "middle";
        h.fillStyle = look.color;
        h.shadowColor = look.shadow;
        h.shadowBlur = look.blur * K;
        h.shadowOffsetX = look.offset * K;
        h.shadowOffsetY = look.offset * K;
        for (var p = 0; p < look.passes; p++) h.fillText(label, (cx2 + spec.textX) * K, (cy2 + spec.textY) * K);
        h.restore();
      }
    }
    return hd;
  }

  function swapSource(g, source, image) {
    var r = g.renderer;
    var old = source.glTexture;
    source.image = image;
    source.glTexture = r.createTextureFromSource(image, source.width, source.height, source.scaleMode);
    try { if (old) r.deleteTexture(old); } catch (e) {}
  }

  function syncHdButtons() {
    var g = window.game;
    if (!g || !g.textures || !g.renderer || typeof g.renderer.createTextureFromSource !== "function") return;
    var K = hdFactor();
    var lang = typeof window.lang === "string" ? window.lang : "en";
    for (var n = 0; n < CFG.hdButtons.length; n++) {
      var spec = CFG.hdButtons[n];
      var rec = st.hd[spec.key];
      var tex = g.textures.exists(spec.key) ? g.textures.get(spec.key) : null;
      var source = tex && tex.source && tex.source[0];
      // 貼圖被重新載入過（換了一個 Texture）：舊紀錄作廢，不去還原一個已經沒人用的來源
      if (rec && (!source || rec.source !== source)) { delete st.hd[spec.key]; rec = null; }
      if (!source) continue;
      // ⚠ 這個語言沒有字就維持原圖（1）—— 不能每一幀去畫一張畫不出字的圖
      var want = K > 1 && hdLabelReady(spec, lang) ? K : 1;
      if ((rec ? rec.k : 1) === want && (!rec || rec.lang === lang)) continue;
      // 還沒載完的圖（寬 0）下一格再來
      var orig = rec ? rec.orig : source.image;
      if (!orig || !(orig.width > 0) || orig.width !== source.width) continue;
      try {
        if (want === 1) {
          swapSource(g, source, orig);
          delete st.hd[spec.key];
        } else {
          swapSource(g, source, drawHdButton(spec, orig, want, lang));
          st.hd[spec.key] = { source: source, orig: orig, k: want, lang: lang };
        }
      } catch (e) { fail(e); }
    }
  }

  function restoreHdButtons() {
    var g = window.game;
    for (var key in st.hd) {
      var rec = st.hd[key];
      try { if (g && g.renderer) swapSource(g, rec.source, rec.orig); } catch (e) {}
    }
    st.hd = {};
  }

  function onPostRender() {
    try { syncHdButtons(); } catch (e) {}
    if (st.pending.length === 0) return;
    var list = st.pending;
    st.pending = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var target = t.__ulrPending;
      delete t.__ulrPending;
      if (!alive(t) || target === undefined) continue;
      try {
        if (t.__ulrRes0 === undefined) {
          t.__ulrRes0 = t.style.resolution || 1;
          st.texts.push(t);
        }
        t.setResolution(target);
        if (target === t.__ulrRes0) delete t.__ulrRes0;
      } catch (e) {}
    }
    if (st.texts.length > 2000) st.texts = st.texts.filter(function (t) { return alive(t) && t.__ulrRes0 !== undefined; });
  }

  /** 新加進場景的物件是沒見過的文字類別（例如 rexBBCodeText）就把它的原型也包起來。 */
  function wrapAddHooks() {
    var P = window.Phaser;
    var targets = [
      P && P.GameObjects && P.GameObjects.DisplayList && P.GameObjects.DisplayList.prototype,
      P && P.GameObjects && P.GameObjects.Container && P.GameObjects.Container.prototype
    ];
    var names = ["addChildCallback", "addHandler"];
    targets.forEach(function (proto, i) {
      var name = names[i];
      if (!proto || typeof proto[name] !== "function" || proto["__ulr_" + name]) return;
      var hadOwn = Object.prototype.hasOwnProperty.call(proto, name);
      var orig = proto[name];
      proto["__ulr_" + name] = orig;
      proto[name] = function (gameObject) {
        try { if (isTextLike(gameObject)) wrapTextProto(Object.getPrototypeOf(gameObject)); } catch (e) {}
        return orig.apply(this, arguments);
      };
      st.addHooks.push({ proto: proto, name: name, orig: orig, hadOwn: hadOwn });
    });
  }

  function unwrapAddHooks() {
    for (var i = 0; i < st.addHooks.length; i++) {
      var h = st.addHooks[i];
      try {
        if (h.hadOwn) h.proto[h.name] = h.orig;
        else delete h.proto[h.name];
        delete h.proto["__ulr_" + h.name];
      } catch (e) {}
    }
    st.addHooks = [];
  }

  /** 裝上時已經存在的文字類別：掃一次（只有這一次）。 */
  function wrapExistingTexts(g) {
    var P = window.Phaser;
    if (P && P.GameObjects && P.GameObjects.Text) wrapTextProto(P.GameObjects.Text.prototype);
    var scenes;
    try { scenes = g.scene.getScenes(false); } catch (e) { return; }
    var seen = [];
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (!o) continue;
        if (o.list && o.list.length) walk(o.list);
        if (isTextLike(o)) {
          var proto = Object.getPrototypeOf(o);
          if (seen.indexOf(proto) === -1) { seen.push(proto); wrapTextProto(proto); }
        }
      }
    }
    for (var s = 0; s < scenes.length; s++) {
      var list = scenes[s].children && scenes[s].children.list;
      if (list) walk(list);
    }
  }

  function restoreTexts() {
    for (var i = 0; i < st.texts.length; i++) {
      var t = st.texts[i];
      try {
        if (alive(t) && t.__ulrRes0 !== undefined) t.setResolution(t.__ulrRes0);
        delete t.__ulrRes0;
        delete t.__ulrPending;
      } catch (e) {}
    }
    st.texts = [];
    st.pending = [];
  }

  /** 文字掛鉤只裝一次（跟著 game 物件走）。倍率回到 1 時掛鉤留著，只是不再排隊。 */
  function ensureTextHooks(g) {
    if (st.postRender && st.postRender.g === g) return;
    if (st.postRender) removeTextHooks();
    wrapExistingTexts(g);
    wrapAddHooks();
    var fn = function () { try { onPostRender(); } catch (e) {} };
    g.events.on("postrender", fn);
    st.postRender = { g: g, fn: fn };
  }

  function removeTextHooks() {
    if (st.postRender) {
      try { st.postRender.g.events.off("postrender", st.postRender.fn); } catch (e) {}
      st.postRender = null;
    }
    unwrapAddHooks();
    unwrapTextProtos();
  }

  /** 倍率變了：已經補過的字下一格會自己重算（checkText 看 __ulrRes0），這裡只把 1 倍時的字還原。 */
  function syncTexts() {
    var g = window.game;
    if (!g || !g.events) return;
    ensureTextHooks(g);
    if (currentScale() <= 1 && st.texts.length > 0) restoreTexts();
  }

  // =========================================================================
  // ② 畫面大小與全螢幕
  // =========================================================================

  function shell() {
    try {
      if (window.parent && window.parent !== window) {
        var d = window.parent.document;
        if (d && d.getElementById("frame_game")) return { kind: "desktop", win: window.parent, doc: d };
      }
    } catch (e) {
      // ⚠ 2026-09-23 起的桌面版：iframe 跨來源又在自己的程序，讀 parent.document
      // 直接丟例外。這時**絕不能**退回 "web" —— 網頁版那條會把 iframe 裡的 body
      // 推到左上角，而外殼把 iframe 擺在 left:-170，畫面左邊就被切掉了。
      return { kind: "remote", win: window, doc: window.document };
    }
    return { kind: "web", win: window, doc: window.document };
  }

  /**
   * remote：外殼摸不到，畫面大小與全螢幕由 Node 對外殼下（shell-display.ts），
   * 這裡不做。只把舊版（誤判成網頁版時）留在 iframe 裡的樣式清回官方原樣。
   * 外殼放大之後 iframe 的 devicePixelRatio 跟著變，高解析度自己會跟上。
   *
   * ⚠ 官方 iframe 頁面是 <body style="margin: 0px;">（2026-09-24 從 HTTP 快取
   * 讀的原始 HTML），外殼的 left:-170 就是照「沒有 margin」算的。margin 清成空字串
   * 會露出瀏覽器預設的 8px，畫面往右下偏、右邊與底下各被切 8px（玩家回報）。
   * 所以 margin 要釘回 0px，不是清掉 —— 也順便修好被那一版清掉的頁面。
   */
  function clearRemote(sh) {
    var body = sh.doc.body, html = sh.doc.documentElement;
    if (body && body.style) {
      body.style.margin = "0px"; body.style.padding = "";
      body.style.paddingLeft = ""; body.style.paddingTop = "";
      body.style.justifyItems = ""; body.style.alignContent = "";
    }
    if (html && html.style) { html.style.background = ""; html.style.zoom = ""; }
    if (html && typeof html.removeAttribute === "function") html.removeAttribute(DATA_ZOOM);
    st.zoom = 1;
    st.fullscreen = false;
    st.fsPending = false;
  }

  function zoomOf(mode) {
    var n = parseFloat(String(mode).slice(1));
    return n > 0 ? n : 1;
  }

  /** 螢幕的 DIP 尺寸。強制 scale factor 時 screen.width/height 被多除了一次。 */
  function screenSize(win) {
    var s = win.screen;
    var k = s.width > 0 && s.availWidth > s.width ? s.availWidth / s.width : 1;
    return {
      w: Math.round(s.width * k), h: Math.round(s.height * k),
      aw: s.availWidth, ah: s.availHeight,
      ax: s.availLeft || 0, ay: s.availTop || 0
    };
  }

  /**
   * 視窗框（標題列＋邊框）佔多少（DIP）。**量到一次就記住**：resizeTo 之後
   * outer 先變、inner 慢一拍，那一瞬間量會得到 0，接著就會用 0 再算一次大小
   * （2026-09-13 實測 ×1 變成 750×654）。全螢幕時 outer==inner 也不能拿來算。
   */
  /**
   * 視窗框（標題列＋邊框）多寬。**每個實例只量一次**，之後沿用。
   *
   * ⚠ outer 與 inner 在 resize 期間各自非同步更新（實測兩種順序都有），所以
   * 只有「視窗沒在動」時量到的那一對才可信。安裝當下視窗還沒被我們動過
   * （重裝時舊實例不還原視窗，見 uninstall 的 keepWindow），就是那一刻。
   * 不要存到 DOM 跨實例沿用 —— 存到一次壞值就永遠壞（2026-09-13 踩過）。
   * 量不到（全螢幕中）就用官方視窗的值：776×719 外框 − 766×694 內容。
   */
  function frameDelta(win) {
    if (st.frame) return st.frame;
    var w = win.outerWidth - win.innerWidth, h = win.outerHeight - win.innerHeight;
    if (!(w > 0 && h > 0) || (win.document && win.document.fullscreenElement)) { w = 10; h = 25; }
    st.frame = { w: w, h: h };
    return st.frame;
  }

  /**
   * 視窗內容區在 ×1 時該多大（DIP）＝ 遊戲畫面本身（760×680）。
   *
   * ⚠ 不是官方 BrowserWindow 的內容區（766×694）：官方視窗右邊、下面本來就多
   * 6／14px 黑邊，照那個放大會變成一圈黑框（玩家 2026-09-13 退件）。內容區剛好
   * 等於畫面，外殼的 iframe 負邊距會把畫面貼齊左上角。
   */
  function baseInner(sh) {
    var g = window.game;
    return g && g.canvas ? logicalSize(g) : { w: 760, h: 680 };
  }

  /**
   * 能放多大還塞得進工作區。網頁版的框（分頁列＋網址列）每次現量：瀏覽器沒有
   * 桌面版那個「resize 中 outer/inner 不同步」的問題，量不到（全螢幕）就不限。
   */
  function maxZoom(sh) {
    var s = screenSize(sh.win), b = baseInner(sh), f;
    if (sh.kind === "desktop") f = frameDelta(sh.win);
    else {
      f = { w: sh.win.outerWidth - sh.win.innerWidth, h: sh.win.outerHeight - sh.win.innerHeight };
      if (!(f.w >= 0 && f.h > 0) || fullscreenElement(sh)) return 99;
    }
    return Math.min((s.aw - f.w) / b.w, (s.ah - f.h) / b.h);
  }

  function remoteMaxZoom() {
    var s = screenSize(window), b = baseInner(null);
    return Math.min((s.aw - 16) / b.w, (s.ah - 39) / b.h);
  }

  /** 兩邊都放大整頁（桌面版是外殼頁、網頁版是遊戲頁本身），理由見檔頭的表。 */
  function zoomTarget(sh) {
    return sh.doc.documentElement;
  }

  function setZoom(sh, z) {
    var el = zoomTarget(sh);
    if (!el || !el.style) return;
    var v = Math.abs(z - 1) < 0.001 ? "" : String(Math.round(z * 1000) / 1000);
    if (el.style.zoom !== v) el.style.zoom = v;
    // 上一版網頁版把 zoom 套在 canvas 上。重裝時不清掉會放大兩次。
    var c = window.game && window.game.canvas;
    if (c && c.style && c.style.zoom) c.style.zoom = "";
    if (typeof el.setAttribute === "function") {
      if (v) el.setAttribute(DATA_ZOOM, v);
      else el.removeAttribute(DATA_ZOOM);
    }
    st.zoom = z;
  }

  /**
   * 網頁版：清掉官方外殼那圈白邊，畫面貼齊左上角。拆掉時還原成官方樣式 ——
   * 官方頁面本來沒有 inline style（實測 body 的 style 屬性是 null），所以
   * 清成空字串就是還原，不必記原值（記在實例上的話重裝會把改過的當原值）。
   */
  function webFrame(sh, on) {
    if (sh.kind !== "web") return;
    var body = sh.doc.body, html = sh.doc.documentElement;
    if (body && body.style) {
      body.style.margin = on ? "0px" : "";
      body.style.padding = on ? "0px" : "";
      body.style.justifyItems = on ? "start" : "";
      // ⚠ body 是 grid，兩列：Phaser 的 DOM 容器（放輸入框，margin-bottom 負 680
      // 疊在 canvas 上）與 canvas。視窗比畫面高時 grid 會把多的高度平分給兩列，
      // canvas 被往下推、輸入框留在原地 —— 字飄到框上面（2026-09-13 實測 ×1.2
      // 差 14px）。多的空間要留在最底下。
      body.style.alignContent = on ? "start" : "";
    }
    if (html && html.style) html.style.background = on ? "#000" : "";
  }

  /** 網頁版：請 Node 把瀏覽器視窗的內容區調成剛好 760z×680z。 */
  function requestWebWindow(sh, z) {
    if (sh.kind !== "web" || fullscreenElement(sh)) return;
    var b = baseInner(sh), s = screenSize(sh.win);
    report({
      type: "display-window",
      width: Math.round(b.w * z), height: Math.round(b.h * z),
      innerWidth: sh.win.innerWidth, innerHeight: sh.win.innerHeight,
      availLeft: s.ax, availTop: s.ay, availWidth: s.aw, availHeight: s.ah
    });
  }

  /** 把視窗內容區調成 760z×680z（resizeTo 吃的是外框，所以加上邊框）。 */
  function resizeDesktop(sh, z) {
    var win = sh.win, f = frameDelta(win), b = baseInner(sh);
    var w = Math.round(b.w * z) + f.w, h = Math.round(b.h * z) + f.h;
    win.resizeTo(w, h);
    // 放大後別讓視窗跑出工作區。⚠ 用實際拿到的尺寸算，不用要求的 —— 要的比
    // 工作區大時 Chromium 會夾小，照要求的算會把視窗推到負座標。
    var s = screenSize(win);
    var ow = win.outerWidth > 0 ? Math.min(w, win.outerWidth) : w;
    var oh = win.outerHeight > 0 ? Math.min(h, win.outerHeight) : h;
    var x = Math.max(s.ax, Math.min(win.screenX, s.ax + s.aw - ow));
    var y = Math.max(s.ay, Math.min(win.screenY, s.ay + s.ah - oh));
    if (x !== win.screenX || y !== win.screenY) win.moveTo(x, y);
  }

  /** 全螢幕時把遊戲置中：外殼 body 的 padding（zoom 之後的座標系）。 */
  function centerPadding(sh, z) {
    var body = sh.doc.body;
    if (!body) return;
    // 網頁版的「沒有 padding」是 0（webFrame 蓋掉官方的 50px），清成空字串會露回來
    var none = sh.kind === "web" ? "0px" : "";
    if (z === null) { body.style.paddingLeft = none; body.style.paddingTop = none; return; }
    var s = logicalSize(window.game || { canvas: { width: 760, height: 680 } });
    body.style.paddingLeft = Math.max(0, Math.floor((sh.win.innerWidth / z - s.w) / 2)) + "px";
    body.style.paddingTop = Math.max(0, Math.floor((sh.win.innerHeight / z - s.h) / 2)) + "px";
  }

  function fullscreenElement(sh) {
    return sh.doc.fullscreenElement || null;
  }

  /** 視窗多大就把遊戲（760×680）放到多大、置中。視窗被 Node 推大時 resize 會再叫一次。 */
  function fitFullscreen(sh) {
    var g = window.game;
    var s = logicalSize(g || { canvas: { width: 760, height: 680 } });
    var z = Math.min(sh.win.innerWidth / s.w, sh.win.innerHeight / s.h);
    if (!(z > 0)) return;
    setZoom(sh, z);
    centerPadding(sh, z);
  }

  function reportFullscreen(sh, active) {
    report({ type: "display-fullscreen", active: !!active, host: sh.kind });
  }

  function enterFullscreen(sh) {
    if (fullscreenElement(sh)) { st.fullscreen = true; fitFullscreen(sh); return; }
    // ⚠ 桌面版不先 resizeTo：那會被夾在工作區裡，而且 Electron 會把夾過的尺寸
    // 記成還原目標。進去之後由 Node 用 SetWindowPos 推滿（見 window-fill.ts）。
    var p;
    try { p = sh.doc.documentElement.requestFullscreen(); } catch (e) { p = null; }
    if (!p || typeof p.then !== "function") { st.fsPending = true; return; }
    st.fsPending = false;
    p.then(function () {
      st.fullscreen = true;
      st.fsPending = false;
      fitFullscreen(sh);
      paintPage();
      reportFullscreen(sh, true);
    }, function () {
      // 沒有使用者手勢：等玩家在遊戲裡點一下
      st.fsPending = true;
    });
  }

  function leaveFullscreen(sh) {
    st.fsPending = false;
    if (fullscreenElement(sh)) {
      st.fsLeaving = true;
      try { sh.doc.exitFullscreen(); } catch (e) {}
    }
    st.fullscreen = false;
    centerPadding(sh, null);
  }

  function watchFullscreen(sh) {
    if (st.fsListener && st.fsListener.doc === sh.doc) return;
    unwatchFullscreen();
    var fn = function () {
      var inFs = !!fullscreenElement(sh);
      if (inFs) { st.fullscreen = true; fitFullscreen(sh); return; }
      var byUs = st.fsLeaving;
      st.fsLeaving = false;
      st.fullscreen = false;
      // 退出時 Electron／瀏覽器自己把視窗還原（樣式與位置都是它在進去時記的）
      centerPadding(sh, null);
      reportFullscreen(sh, false);
      // 玩家按 Esc 離開：設定跟著退回上一個大小，並回報讓配置也改掉
      if (!byUs && st.state.size === "fullscreen") {
        st.state = { render: st.state.render, size: st.lastSize === "fullscreen" ? "x1" : st.lastSize };
        applySize();
        paintPage();
        report({ type: "display-settings", render: st.state.render, size: st.state.size });
      }
    };
    sh.doc.addEventListener("fullscreenchange", fn);
    st.fsListener = { doc: sh.doc, fn: fn };
  }

  function unwatchFullscreen() {
    if (!st.fsListener) return;
    try { st.fsListener.doc.removeEventListener("fullscreenchange", st.fsListener.fn); } catch (e) {}
    st.fsListener = null;
  }

  function watchClick() {
    if (st.fsClick) return;
    var fn = function () {
      if (!st.fsPending || st.state.size !== "fullscreen") return;
      try { enterFullscreen(shell()); } catch (e) { fail(e); }
    };
    window.addEventListener("pointerdown", fn, true);
    st.fsClick = fn;
  }

  function unwatchClick() {
    if (!st.fsClick) return;
    try { window.removeEventListener("pointerdown", st.fsClick, true); } catch (e) {}
    st.fsClick = null;
  }

  /** 照 st.state.size 套用。只在狀態改變或安裝時叫，不在輪詢裡叫（會跟玩家的視窗打架）。 */
  function applySize() {
    var sh = shell();
    st.host = sh.kind;
    if (sh.kind === "remote") { clearRemote(sh); return; }
    watchFullscreen(sh);
    webFrame(sh, true);
    var mode = st.state.size;
    if (mode === "fullscreen") {
      watchClick();
      if (!st.fullscreen) enterFullscreen(sh);
      else fitFullscreen(sh);
      return;
    }
    st.lastSize = mode;
    if (st.fullscreen || fullscreenElement(sh)) leaveFullscreen(sh);
    // ⚠ 不夾在工作區裡（玩家 2026-09-13 定：「上限請設 ×4」）。1440 高的螢幕扣掉
    // 工作列剛好 ×2，原本夾了之後打 2.1 也只會得到 2。超過的部分 Chromium 仍會把
    // 視窗夾在工作區、畫面被切掉 —— 那是玩家自己選的；下拉清單照樣只列塞得進的。
    var z = zoomOf(mode);
    setZoom(sh, z);
    if (sh.kind === "desktop") resizeDesktop(sh, z);
    // ⚠ 全螢幕剛退出時瀏覽器正在還原視窗，這時回報會量到還原中的 inner。
    // requestWebWindow 自己擋掉仍在全螢幕的情形；Esc 離開那條路走到這裡時
    // fullscreenElement 已經是 null，量到的是瀏覽器還原後的值。
    requestWebWindow(sh, z);
  }

  function resetSize(keepWindow) {
    var sh = shell();
    unwatchClick();
    unwatchFullscreen();
    if (sh.kind === "remote") { clearRemote(sh); return; }
    if (keepWindow) return;
    if (st.fullscreen || fullscreenElement(sh)) leaveFullscreen(sh);
    setZoom(sh, 1);
    if (sh.kind === "desktop") {
      centerPadding(sh, null);
      resizeDesktop(sh, 1);
    } else {
      // 還原官方外殼；視窗大小留給玩家（拆掉通常是插件關了，不該去動他的瀏覽器）
      if (sh.doc.body && sh.doc.body.style) { sh.doc.body.style.paddingLeft = ""; sh.doc.body.style.paddingTop = ""; }
      webFrame(sh, false);
    }
  }

  // =========================================================================
  // ③ plugin 分頁鈕：從圖集拼字母
  // =========================================================================

  function frameRect(tex, name) {
    if (!tex.has || !tex.has(name)) return null;
    var f = tex.get(name);
    return { x: f.cutX, y: f.cutY, w: f.cutWidth, h: f.cutHeight };
  }

  /** 一個字在 over 狀態（白字）裡的每個字母佔哪幾欄。 */
  function segments(data, R) {
    var segs = [], start = -1;
    for (var x = 2; x < R.w - 2; x++) {
      var on = false;
      for (var y = 2; y < R.h - 2 && !on; y++) {
        var i = (y * R.w + x) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 150) on = true;
      }
      if (on && start < 0) start = x;
      if (!on && start >= 0) { segs.push([start, x]); start = -1; }
    }
    if (start >= 0) segs.push([start, R.w - 2]);
    return segs;
  }

  function compose(tex) {
    var doc = window.document;
    var img = tex.source && tex.source[0] && tex.source[0].image;
    if (!doc || !img || !img.width) return null;
    var base = frameRect(tex, "volume_out");
    if (!base) return null;
    var fw = base.w, fh = base.h;

    var atlas = doc.createElement("canvas");
    atlas.width = img.width;
    atlas.height = img.height;
    var actx = atlas.getContext("2d", { willReadFrequently: true });
    actx.drawImage(img, 0, 0);

    var out = doc.createElement("canvas");
    out.width = fw;
    out.height = fh * STATES.length;
    var ctx = out.getContext("2d");

    // 2026-09-25 實測 over 狀態：volume 6 段、language 8 段、profile 7 段。
    // 舊圖集的 profile 曾經 r 跟 o 黏在一起，所以 profile 還是只要求至少 5 段、
    // l／i 從尾端數（e、l、i 各自獨立）。
    var words = { volume: [6, 6], language: [8, 8], profile: [5, 7] };
    var segs = {};
    var ok = true;
    Object.keys(words).forEach(function (w) {
      var R = frameRect(tex, w + "_over");
      if (!R) { ok = false; return; }
      segs[w] = segments(actx.getImageData(R.x, R.y, R.w, R.h).data, R);
      if (segs[w].length < words[w][0] || segs[w].length > words[w][1]) ok = false;
    });

    // p l u g i n（負數 = 從尾端數）
    var need = [["profile", 0], ["profile", -2], ["volume", 3], ["language", 3], ["profile", -3], ["language", 2]];
    function segAt(n) {
      var list = segs[n[0]];
      return list[n[1] < 0 ? list.length + n[1] : n[1]];
    }
    var gap = 1, total = 0;
    if (ok) {
      var gaps = [];
      Object.keys(segs).forEach(function (w) {
        for (var i = 1; i < segs[w].length; i++) gaps.push(segs[w][i][0] - segs[w][i - 1][1]);
      });
      gaps.sort(function (a, b) { return a - b; });
      gap = gaps[Math.floor(gaps.length / 2)];
      need.forEach(function (n) { var s = segAt(n); total += s[1] - s[0]; });
      total += gap * (need.length - 1);
    }

    var s0 = ok ? segs.volume[0][0] : 0;
    var s1 = ok ? segs.volume[segs.volume.length - 1][1] : 0;
    var center = ok ? (s0 + s1) / 2 : fw / 2;
    // 段是從 over（沒描邊）量的；out 的字有 1px 描邊、各狀態也會差 1px，
    // 切字母時左右各多拿一點（lighten 疊上去，多拿的底不會變暗）。
    var pad = 1;

    for (var si = 0; si < STATES.length; si++) {
      var R = frameRect(tex, "volume_" + STATES[si]);
      if (!R) return null;
      var oy = si * fh;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(atlas, R.x, R.y, R.w, R.h, 0, oy, fw, fh);

      // 用字左邊那段素面把 volume 蓋掉（上下框線那兩列不動）
      var eraseL = ok ? s0 - 3 : 6;
      var eraseR = ok ? s1 + 3 : fw - 6;
      var stripX = 3;
      var stripW = eraseL - stripX - 1;
      if (stripW < 2) return null;
      for (var x = eraseL; x < eraseR; x += stripW) {
        var w = Math.min(stripW, eraseR - x);
        ctx.drawImage(atlas, R.x + stripX, R.y + 1, w, fh - 2, x, oy + 1, w, fh - 2);
      }

      if (ok) {
        // 字比底亮：lighten 只留下字
        ctx.globalCompositeOperation = "lighten";
        var cx = Math.round(center - total / 2);
        for (var k = 0; k < need.length; k++) {
          var seg = segAt(need[k]);
          var src = frameRect(tex, need[k][0] + "_" + STATES[si]);
          var gw = seg[1] - seg[0];
          ctx.drawImage(atlas, src.x + seg[0] - pad, src.y + 1, gw + pad * 2, fh - 2, cx - pad, oy + 1, gw + pad * 2, fh - 2);
          cx += gw + gap;
        }
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.fillStyle = STATES[si] === "out" ? "#8c8c8c" : "#ffffff";
        ctx.font = "bold 11px font_heavy, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(TAB, fw / 2, oy + fh / 2 + 1);
      }
    }
    return { canvas: out, fw: fw, fh: fh, glyphs: ok };
  }

  function ensureFrames(tex) {
    if (!tex || tex.key !== TAB_KEY) return false;
    if (st.tex === tex && tex.has(TAB + "_out")) return true;
    var made = compose(tex);
    var Phaser = window.Phaser;
    if (!made || !Phaser || !Phaser.Textures || !Phaser.Textures.TextureSource) return false;
    var source = new Phaser.Textures.TextureSource(tex, made.canvas, made.canvas.width, made.canvas.height);
    tex.source.push(source);
    var idx = tex.source.length - 1;
    for (var i = 0; i < STATES.length; i++) tex.add(TAB + "_" + STATES[i], idx, 0, i * made.fh, made.fw, made.fh);
    st.tex = tex;
    st.texSource = source;
    st.glyphs = made.glyphs;
    return true;
  }

  function removeFrames() {
    var tex = st.tex;
    if (!tex) return;
    try {
      for (var i = 0; i < STATES.length; i++) {
        var name = TAB + "_" + STATES[i];
        if (typeof tex.remove === "function") tex.remove(name);
        else if (tex.frames) { delete tex.frames[name]; tex.frameTotal -= 1; }
      }
      var at = tex.source ? tex.source.indexOf(st.texSource) : -1;
      if (at >= 0) tex.source.splice(at, 1);
      if (st.texSource && st.texSource.destroy) st.texSource.destroy();
    } catch (e) {}
    st.tex = null;
    st.texSource = null;
  }

  function optionScene() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    return (keys && keys.Option) || null;
  }

  /** 貼圖在就補 frame；貼圖重新載入的那一刻（addtexture，發生在 create 之前）也補。 */
  function syncFrames() {
    var g = window.game;
    if (!g || !g.textures) return false;
    if (st.texManager !== g.textures) {
      if (st.texManager && st.texListener) { try { st.texManager.off("addtexture", st.texListener); } catch (e) {} }
      st.texListener = function (key, tex) {
        if (key !== TAB_KEY) return;
        try { ensureFrames(tex); } catch (e) { fail(e); }
      };
      g.textures.on("addtexture", st.texListener);
      st.texManager = g.textures;
    }
    var tex = g.textures.exists(TAB_KEY) ? g.textures.get(TAB_KEY) : null;
    try { return !!tex && ensureFrames(tex); } catch (e) { fail(e); return false; }
  }

  /**
   * 官方的分頁名 —— 從圖集的「名_out」frame 讀（清單本身是模組私有的摸不到），
   * 只留場景上真的有「btn_名」的，照鈕的 x 排。
   */
  function officialTabs(sc) {
    var tex = st.tex;
    if (!tex || !tex.frames) return [];
    return Object.keys(tex.frames)
      .filter(function (n) { return /_out$/.test(n) && n !== TAB + "_out"; })
      .map(function (n) { return n.slice(0, -4); })
      .filter(function (n) { return alive(sc["btn_" + n]); })
      .sort(function (a, b) { return sc["btn_" + a].x - sc["btn_" + b].x; });
  }

  /** 照官方鈕的 pointerup：其他鈕回 _out → 收掉目前分頁 → 自己 _up → 換 category → 畫。 */
  function switchToPlugin(sc) {
    if (sc.category === TAB) return;
    officialTabs(sc).forEach(function (n) {
      sc["btn_" + n].setTexture(TAB_KEY, n + "_out").setInteractive();
    });
    var destroy = sc["destroy_" + sc.category];
    if (typeof destroy === "function") destroy.call(sc);
    sc.btn_plugin.setTexture(TAB_KEY, TAB + "_up").disableInteractive();
    sc.category = TAB;
    sc.show_plugin();
  }

  /** Option 建好之後補一顆鈕接在官方分頁後面，並在場景實例上放 show_plugin／destroy_plugin。 */
  function ensureButton(sc) {
    if (alive(sc.btn_plugin)) return;
    var tabs = officialTabs(sc);
    if (tabs.length === 0) return;
    var first = sc["btn_" + tabs[0]];
    var btn = sc.add.image(first.x + 96 * tabs.length, first.y, TAB_KEY, TAB + "_out").setOrigin(0, 0).setInteractive();
    btn.on("pointerover", function () { btn.setTexture(TAB_KEY, TAB + "_over"); });
    btn.on("pointerout", function () { btn.setTexture(TAB_KEY, TAB + "_out"); });
    btn.on("pointerdown", function () { btn.setTexture(TAB_KEY, TAB + "_out"); });
    btn.on("pointerup", function () { try { switchToPlugin(sc); } catch (e) { fail(e); } });
    sc.btn_plugin = btn;
    sc.show_plugin = function () {
      try { detachPage(); mountPage(sc); } catch (e) { fail(e); }
    };
    // 官方鈕切走時呼叫的：收內容、鈕回 _out（官方的迴圈只重設它自己的那幾顆）
    sc.destroy_plugin = function () {
      try { detachPage(); } catch (e) { fail(e); }
      try { if (alive(sc.btn_plugin)) sc.btn_plugin.setTexture(TAB_KEY, TAB + "_out").setInteractive(); } catch (e) { fail(e); }
    };
  }

  // =========================================================================
  // 分頁內容：照 language 分頁的下拉鈕
  // =========================================================================

  function makeDropdown(sc, y, options, onPick) {
    var dd = { objects: [], options: options, open: false };
    var zone = sc.add.zone(0, 0, 760, 680).setOrigin(0, 0).setDepth(20).setInteractive();
    zone.disableInteractive();
    var btn = sc.add.image(L.x, y, "btn_gene", 0).setInteractive();
    var value = sc.add.text(L.x, y, "", { fontFamily: "font_medium", fontSize: 13, resolution: 2, color: "black" }).setOrigin(0.5, 0.5);
    var sizer = sc.rexUI.add.sizer({ width: 76, orientation: "y", space: { item: 0 } });
    for (var i = 0; i < options.length; i++) {
      var label = sc.rexUI.add.label({
        background: sc.rexUI.add.roundRectangle({ color: 0xffffff }),
        text: sc.add.text(0, 0, pick(options[i].label), { fontFamily: "font_light", color: "black", fontSize: 12, resolution: 2 }).setResolution(2),
        space: { left: 5, right: 5, top: 5, bottom: 5 },
        name: options[i].value
      });
      sizer.add(label, { expand: true });
    }
    var panel = sc.rexUI.add.scrollablePanel({
      x: L.x, y: y + 14, height: 24 * options.length, scrollMode: 0,
      background: sc.rexUI.add.roundRectangle({ strokeColor: 0xb7bbbc, strokeWidth: 2 }),
      panel: { child: sizer }, space: { panel: 0 }
    }).setOrigin(0.5, 0).setDepth(21).layout();

    function close() {
      dd.open = false;
      try { panel.setVisible(false); zone.disableInteractive(); btn.setInteractive(); } catch (e) {}
    }
    zone.on("pointerup", close);
    btn.on("pointerover", function () { btn.setTexture("btn_gene", 1); });
    btn.on("pointerout", function () { btn.setTexture("btn_gene", 0); });
    btn.on("pointerup", function () {
      dd.open = true;
      zone.setInteractive();
      btn.setTexture("btn_gene", 0).disableInteractive();
      panel.setVisible(true);
    });
    panel.setChildrenInteractive({});
    panel.on("child.over", function (child) {
      var bg = child.getElement("background");
      bg.setStrokeStyle(1, 0xff0000);
      bg.fillColor = 0xff7f7f;
    });
    panel.on("child.out", function (child) {
      var bg = child.getElement("background");
      bg.setStrokeStyle();
      bg.fillColor = 0xffffff;
    });
    panel.on("child.up", function (child) {
      close();
      try { onPick(child.name); } catch (e) { fail(e); }
    });
    panel.setVisible(false);

    dd.zone = zone;
    dd.btn = btn;
    dd.value = value;
    dd.panel = panel;
    dd.close = close;
    dd.objects = [zone, btn, value, panel];
    return dd;
  }

  /** 桌面版：塞不進工作區的倍率不列出來（清單是掛分頁時建的，不事後藏）。 */
  function sizeOptionsFor(sh) {
    // remote：外殼由 Node 另開 session 調（shell-display.ts），這裡只負責列清單。
    // 螢幕 iframe 裡也讀得到；視窗框量不到，用官方 ×1 視窗的值（776×719 − 760×680）。
    var zmax = sh.kind === "remote" ? remoteMaxZoom() : maxZoom(sh);
    return CFG.sizeOptions.filter(function (o) {
      if (o.value === "fullscreen" || o.value === CFG.customOption || o.value === "x1") return true;
      return zoomOf(o.value) <= zmax + 0.01;
    });
  }

  /** 按鈕上的字：預設清單裡有就用它的標籤，自訂的倍率直接印 ×1.6。 */
  function sizeLabelFor(value) {
    for (var i = 0; i < CFG.sizeOptions.length; i++) {
      if (CFG.sizeOptions[i].value === value) return pick(CFG.sizeOptions[i].label);
    }
    return typeof value === "string" && value.charAt(0) === "x" ? "\\u00d7" + value.slice(1) : String(value);
  }

  /** 把玩家打的字變成合法的倍率字串；打壞了回 null。 */
  function parseZoomInput(text) {
    var n = parseFloat(String(text).replace(/[^0-9.]/g, ""));
    if (!(n > 0)) return null;
    // 只夾 minZoom〜maxZoom，不夾工作區（理由見 applySize）。
    n = Math.max(CFG.minZoom, Math.min(CFG.maxZoom, n));
    n = Math.round(n * 100) / 100;
    return "x" + String(n);
  }

  function applyPickedSize(v) {
    st.state = { render: st.state.render, size: v };
    applySize();
    syncRender();
    paintPage();
    report({ type: "display-settings", render: st.state.render, size: st.state.size });
  }

  function paintPage() {
    var p = st.page;
    if (!p || !alive(p.size.btn)) return;
    var sc = p.scene;
    try {
      var show = sc.category === TAB;
      for (var i = 0; i < p.objects.length; i++) {
        var o = p.objects[i];
        if (o === p.size.panel || o === p.size.zone) continue;
        // 說明只有 hover 才出現，離開分頁時一律藏起來
        if (o === p.renderTip || o === p.sizeTip) { if (!show) o.setVisible(false); continue; }
        // 自訂輸入框只在選了「自訂」之後出現
        if (o === p.inputBase || o === p.inputText) { o.setVisible(show && st.customOpen); continue; }
        o.setVisible(show);
      }
      if (!show) p.size.close();
      p.title.setText(pick(CFG.tabTitle));
      p.renderLabel.setText(pick(CFG.renderLabel));
      p.check.setPosition(p.renderLabel.getBottomRight().x + L.checkGap, L.renderY);
      var on = st.state.render === "auto";
      if (!!p.check.checked !== on) {
        st.silent = true;
        try { p.check.checked = on; } finally { st.silent = false; }
      }
      p.sizeLabel.setText(pick(CFG.sizeLabel));
      p.size.value.setText(sizeLabelFor(st.state.size));
      if (!p.inputText.isEditing && st.state.size !== "fullscreen") p.inputText.setText(st.state.size.slice(1));
      p.renderTip.setText(pick(CFG.renderTip));
      p.sizeTip.setText(pick(CFG.sizeTip));
    } catch (e) {
      fail(e);
    }
  }

  /** 說明浮在標題**上方**（原點在底），才不會壓到下面的按鈕。 */
  function tipFor(sc, anchor, y, table) {
    var text = sc.add.text(L.x, y, pick(table), {
      fontFamily: "font_light", fontSize: 11, resolution: 2, color: "#ffffff",
      backgroundColor: "rgba(0,0,0,0.85)",
      padding: { left: 5, right: 5, top: 3, bottom: 4 }
    }).setOrigin(0.5, 1).setDepth(30).setVisible(false);
    anchor.setInteractive();
    anchor.on("pointerover", function () { try { text.setVisible(true); } catch (e) {} });
    anchor.on("pointerout", function () { try { text.setVisible(false); } catch (e) {} });
    return text;
  }

  function mountPage(sc) {
    var light = { fontFamily: "font_light", fontSize: 15, resolution: 2 };

    // 分頁標題 —— 照官方 show_language 的 language_label
    var title = sc.add.text(8, 64, pick(CFG.tabTitle), {
      fontFamily: "font_heavy", fontSize: 22, resolution: 2, fontStyle: "italic"
    }).setPadding({ right: 5 }).setOrigin(0, 0);

    // 高解析度 ☑ —— 照 profile 分頁的勾選列
    var renderLabel = sc.add.text(L.x, L.renderY, pick(CFG.renderLabel), light).setOrigin(0.5, 0.5);
    var check = sc.rexUI.add.checkbox({
      x: renderLabel.getBottomRight().x + L.checkGap, y: L.renderY,
      width: L.checkSize, height: L.checkSize,
      color: 0xffffff, checkerColor: 0x000000, boxLineWidth: 2,
      checked: st.state.render === "auto"
    }).setOrigin(0, 0.5);
    check.on("valuechange", function (v) {
      if (st.silent) return;
      st.state = { render: v ? "auto" : "off", size: st.state.size };
      syncRender();
      syncTexts();
      paintPage();
      report({ type: "display-settings", render: st.state.render, size: st.state.size });
    });
    var renderTip = tipFor(sc, renderLabel, L.renderY - 10 - L.tipGap, CFG.renderTip);

    // 畫面大小 —— 下拉，「自訂」打開右邊的輸入框
    var sizeLabel = sc.add.text(L.x, L.sizeLabelY, pick(CFG.sizeLabel), light).setOrigin(0.5, 0);
    var sizeTip = tipFor(sc, sizeLabel, L.sizeLabelY - L.tipGap, CFG.sizeTip);
    var size = makeDropdown(sc, L.sizeButtonY, sizeOptionsFor(shell()), function (v) {
      if (v === CFG.customOption) { openCustom(); return; }
      st.customOpen = false;
      applyPickedSize(v);
    });

    // 自訂輸入框：照 profile 的簡介框（白底 0.7、框線、黑字），rexUI textEdit 點了就能打字
    var inputX = L.x + size.btn.width / 2 + L.inputGap + L.inputW / 2;
    var inputBase = sc.rexUI.add.roundRectangle(inputX, L.sizeButtonY, L.inputW, L.inputH, 2, 0xffffff, 0.7);
    inputBase.setStrokeStyle(1, 0x4f4f4f);
    var inputText = sc.add.text(inputX, L.sizeButtonY, "", {
      fontFamily: "font_light", fontSize: 15, resolution: 2, color: "black", fixedWidth: L.inputW - 10
    }).setOrigin(0.5, 0.5);
    // 舊實例留下的輸入元素先清掉（見 sweepInputs）
    sweepInputs(sc, inputX, L.sizeButtonY, null);
    var editor = sc.rexUI.add.textEdit(inputText, {
      enterClose: true, selectAll: true,
      onOpen: function () { inputBase.setFillStyle(0xffffff, 1); },
      onClose: function (textObject) {
        inputBase.setFillStyle(0xffffff, 0.7);
        var v = parseZoomInput(textObject.text);
        if (v === null) { paintPage(); return; }
        if (v !== st.state.size) applyPickedSize(v);
        else paintPage();
      },
      onTextChanged: function (textObject, text) { textObject.setText(text.replace(/[^0-9.]/g, "").slice(0, 4)); }
    });
    function openCustom() {
      st.customOpen = true;
      paintPage();
      sweepInputs(sc, inputX, L.sizeButtonY, editor.inputText || null);
      try { editor.open(); } catch (e) {}
    }

    var objects = [title, renderLabel, check, sizeLabel, inputBase, inputText].concat(size.objects);

    st.page = {
      scene: sc, objects: objects, size: size, check: check, title: title,
      renderLabel: renderLabel, sizeLabel: sizeLabel,
      inputBase: inputBase, inputText: inputText, editor: editor, inputX: inputX,
      renderTip: renderTip, sizeTip: sizeTip
    };
    st.page.objects.push(renderTip, sizeTip);
    paintPage();
  }

  function detachPage() {
    var p = st.page;
    if (!p) return;
    try { if (p.editor && p.editor.isOpened) p.editor.close(); } catch (e) {}
    st.customOpen = false;
    for (var i = 0; i < p.objects.length; i++) {
      try { if (alive(p.objects[i])) p.objects[i].destroy(); } catch (e) {}
    }
    st.page = null;
    // rexUI 的 close 是延遲做的，那時文字物件已經拆了 —— 輸入元素會留在場景上
    var sc = p.scene, x = p.inputX, y = L.sizeButtonY;
    sweepInputs(sc, x, y, null);
    setTimeout(function () { sweepInputs(sc, x, y, null); }, 300);
  }

  /**
   * 拆掉疊在「自訂」輸入框位置上的 rexInputText（HTML 輸入元素）。
   *
   * ⚠ 2026-09-13 玩家回報「輸入框有不明疊字」：編輯器開著時分頁被卸載（重裝
   * 腳本、換分頁），rexUI 延遲關閉時文字物件已經不在，它建的 rexInputText 就
   * 留在 Option 場景上，下一次打開的新輸入元素疊在它上面。那個殘骸還掛在場景的
   * 顯示清單裡，所以「沒有 Phaser 物件的 input」這種判斷抓不到它 —— 用位置抓：
   * 跟我們輸入框同一點的只會是我們建的（官方簡介框在別處）。
   */
  function sweepInputs(sc, x, y, keep) {
    try {
      var list = (sc && sc.children && sc.children.list) || [];
      for (var i = list.length - 1; i >= 0; i--) {
        var o = list[i];
        if (!o || o === keep || o.type !== "rexInputText") continue;
        if (Math.abs(o.x - x) > 1 || Math.abs(o.y - y) > 1) continue;
        try { o.destroy(); } catch (e) {}
      }
    } catch (e) {}
  }

  // =========================================================================
  // 接上事件。沒有輪詢：只在 game 還沒建好時每 500ms 看一次，建好就停。
  //
  //   繪圖倍率      canvas.width setter（三方改尺寸時自動跟上）＋ window resize
  //   文字解析度    文字類別的 renderWebGL（畫之前排隊、postrender 套用）
  //   plugin 分頁   Option 場景的 create／shutdown，貼圖的 addtexture
  //   全螢幕        fullscreenchange，加上進場後第一次 pointerdown
  // =========================================================================

  function syncOption() {
    var ready = syncFrames();
    var sc = optionScene();
    var active = !!(ready && sc && sc.scene && sc.scene.isActive());
    if (!active) {
      if (st.page) detachPage();
      return;
    }
    ensureButton(sc);
    // 重裝時玩家正停在 plugin 分頁（舊實例拆掉時已切回第一頁，這裡只是保險）
    if (sc.category !== TAB) return;
    if (!st.page || st.page.scene !== sc || !alive(st.page.check)) {
      detachPage();
      mountPage(sc);
    } else {
      paintPage();
    }
  }

  function onResize() {
    try {
      syncRender();
      var sh = shell();
      if (st.state.size === "fullscreen" && st.fullscreen) {
        if (fullscreenElement(sh)) fitFullscreen(sh);
      }
    } catch (e) { fail(e); }
  }

  function attachGame(g) {
    if (st.game === g) return true;
    if (!g || !g.events || !g.scene || !g.scene.keys) return false;
    st.game = g;
    syncRender();
    syncTexts();
    syncFrames();
    var sc = optionScene();
    if (sc && sc.events) {
      var onCreate = function () { try { syncOption(); } catch (e) { fail(e); } };
      var onShutdown = function () { try { detachPage(); } catch (e) { fail(e); } };
      sc.events.on("create", onCreate);
      sc.events.on("shutdown", onShutdown);
      st.sceneHooks = { sc: sc, create: onCreate, shutdown: onShutdown };
      // 裝上時玩家可能已經在 Option 裡
      try { syncOption(); } catch (e) { fail(e); }
    }
    return true;
  }

  function detachGame() {
    if (st.sceneHooks) {
      try {
        st.sceneHooks.sc.events.off("create", st.sceneHooks.create);
        st.sceneHooks.sc.events.off("shutdown", st.sceneHooks.shutdown);
      } catch (e) {}
      st.sceneHooks = null;
    }
    st.game = null;
  }

  /** 玩家先開插件再開遊戲：等 window.game 出現。建好就停，不會一直跑。 */
  function waitForGame() {
    if (attachGame(window.game)) return;
    st.timer = setInterval(function () {
      try {
        if (!attachGame(window.game)) return;
        clearInterval(st.timer);
        st.timer = null;
      } catch (e) { fail(e); }
    }, CFG.pollIntervalMs);
  }

  function normalize(next) {
    var render = next && next.render === "auto" ? "auto" : "off";
    var size = "x1";
    if (next && next.size === "fullscreen") size = "fullscreen";
    else if (next && typeof next.size === "string" && /^x\\d+(\\.\\d+)?$/.test(next.size)) {
      var n = Number(next.size.slice(1));
      if (n >= CFG.minZoom && n <= CFG.maxZoom) size = next.size;
    }
    return { render: render, size: size };
  }

  st.setState = function (next) {
    var n = normalize(next);
    var sizeChanged = n.size !== st.state.size;
    st.state = n;
    if (sizeChanged) applySize();
    syncRender();
    syncTexts();
    paintPage();
  };

  /** 拆掉。opts.keepWindow = 正在重裝，視窗、zoom、全螢幕留給新實例接手。 */
  st.uninstall = function (opts) {
    var keepWindow = !!(opts && opts.keepWindow);
    try { if (st.timer !== null) clearInterval(st.timer); } catch (e) {}
    st.timer = null;
    detachPage();
    var sc = optionScene();
    if (sc && (sc.btn_plugin || sc.show_plugin)) {
      try {
        // 停在 plugin 分頁上 → 照官方的切法切回第一頁
        if (sc.category === TAB) {
          var tabs = officialTabs(sc);
          if (tabs.length > 0 && sc.scene && sc.scene.isActive()) {
            var first = tabs[0];
            sc["btn_" + first].setTexture(TAB_KEY, first + "_up").disableInteractive();
            sc.category = first;
            sc["show_" + first]();
          }
        }
        if (alive(sc.btn_plugin)) sc.btn_plugin.destroy();
        delete sc.btn_plugin;
        delete sc.show_plugin;
        delete sc.destroy_plugin;
      } catch (e) {}
    }
    try { if (st.texManager && st.texListener) st.texManager.off("addtexture", st.texListener); } catch (e) {}
    removeFrames();
    detachGame();
    try { window.removeEventListener("resize", onResize); } catch (e) {}
    try { if (st.shellWin) st.shellWin.removeEventListener("resize", onResize); } catch (e) {}
    st.shellWin = null;
    try { resetSize(keepWindow); } catch (e) {}
    restoreTexts();
    restoreHdButtons();
    removeTextHooks();
    unhook(st.hook);
    st.hook = null;
    try { delete window[FLAG]; } catch (e) { window[FLAG] = undefined; }
    return "ok";
  };

  window[FLAG] = st;
  st.state = normalize(st.state);
  try { applySize(); } catch (e) { fail(e); }
  // 桌面版的 iframe 大小是固定的，變的是外殼視窗 —— 兩邊都聽
  window.addEventListener("resize", onResize);
  try { var sh0 = shell(); if (sh0.win !== window) { st.shellWin = sh0.win; sh0.win.addEventListener("resize", onResize); } } catch (e) {}
  waitForGame();

  return JSON.stringify(statusOf());

  function statusOf() {
    return {
      installed: true,
      version: st.version,
      state: st.state,
      scale: currentScale(),
      buffer: bufferText(),
      host: st.host,
      zoom: st.zoom,
      fullscreen: !!st.fullscreen,
      fullscreenPending: !!st.fsPending,
      texts: st.texts.length,
      tab: !!st.tex,
      glyphs: st.glyphs,
      mounted: !!st.page,
      reason: st.reason
    };
  }
})()`;
}

export function buildDisplayStateExpression(state: DisplayState): string {
  return `(function () {
  var st = window["${FLAG}"];
  if (!st || typeof st.setState !== "function") return "not-installed";
  st.setState(JSON.parse(${embedJson(state)}));
  return "ok";
})()`;
}

const EMPTY_STATUS = `{ installed: false, version: null, state: null, scale: null, buffer: null, host: null, zoom: null, fullscreen: false, fullscreenPending: false, texts: 0, tab: false, glyphs: null, mounted: false, reason: null }`;

export const DISPLAY_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify(${EMPTY_STATUS});
    var buffer = null;
    try {
      var c = window.game && window.game.canvas;
      var p = c && Object.getPrototypeOf(c);
      var dw = null, dh = null;
      while (p && (!dw || !dh)) {
        dw = dw || Object.getOwnPropertyDescriptor(p, "width");
        dh = dh || Object.getOwnPropertyDescriptor(p, "height");
        p = Object.getPrototypeOf(p);
      }
      if (c && dw && dh) buffer = dw.get.call(c) + "x" + dh.get.call(c);
    } catch (e) {}
    return JSON.stringify({
      installed: true,
      version: st.version,
      state: st.state,
      scale: st.hook ? st.hook.scale : 1,
      buffer: buffer,
      host: st.host,
      zoom: st.zoom,
      fullscreen: !!st.fullscreen,
      fullscreenPending: !!st.fsPending,
      texts: st.texts ? st.texts.length : 0,
      tab: !!st.tex,
      glyphs: st.glyphs,
      mounted: !!st.page,
      reason: st.reason
    });
  } catch (e) {
    var out = ${EMPTY_STATUS};
    out.reason = String((e && e.message) || e);
    return JSON.stringify(out);
  }
})()`;

export const DISPLAY_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st || typeof st.uninstall !== "function") return "not-installed";
    return st.uninstall();
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseDisplayStatus(raw: string): DisplayStatus {
  const empty: DisplayStatus = {
    installed: false,
    version: null,
    state: null,
    scale: null,
    buffer: null,
    host: null,
    zoom: null,
    fullscreen: false,
    fullscreenPending: false,
    texts: 0,
    tab: false,
    glyphs: null,
    mounted: false,
    reason: null,
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...empty, reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}` };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const s = (o["state"] ?? null) as Record<string, unknown> | null;
  return {
    installed: o["installed"] === true,
    version: typeof o["version"] === "number" ? o["version"] : null,
    state:
      s !== null && isRenderMode(s["render"]) && isSizeMode(s["size"])
        ? { render: s["render"], size: s["size"] }
        : null,
    scale: typeof o["scale"] === "number" ? o["scale"] : null,
    buffer: typeof o["buffer"] === "string" ? o["buffer"] : null,
    host:
      o["host"] === "desktop" || o["host"] === "web" || o["host"] === "remote" ? o["host"] : null,
    zoom: typeof o["zoom"] === "number" ? o["zoom"] : null,
    fullscreen: o["fullscreen"] === true,
    fullscreenPending: o["fullscreenPending"] === true,
    texts: typeof o["texts"] === "number" ? o["texts"] : 0,
    tab: o["tab"] === true,
    glyphs: typeof o["glyphs"] === "boolean" ? o["glyphs"] : null,
    mounted: o["mounted"] === true,
    reason: typeof o["reason"] === "string" ? o["reason"] : null,
  };
}
