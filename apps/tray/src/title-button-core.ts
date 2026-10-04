/**
 * 遊戲視窗標題列上的「重新整理」鈕 —— 不碰 Electron 的部分
 * ======================================================
 * 玩家 2026-09-26：「重新載入不方便，也常常被蓋住不能按」—— 遊戲裡的東西會被
 * 面板蓋住、白畫面時根本沒有東西可按。要一顆**永遠按得到**的。
 *
 * 做法：托盤開一個很小的無框視窗，由一支常駐的 PowerShell（C#）把它貼在遊戲
 * 視窗的「最小化」左邊。它是另一個程序的另一個視窗，遊戲畫面怎樣都蓋不到它；
 * 按下去走 CDP 對外殼 `Page.reload`，白畫面、斷線照樣有效。
 *
 * ## 為什麼不把它設成遊戲視窗的 owned window
 *
 * owned window 會自動跟著主視窗的 Z 順序、最小化，看起來最省事。但**跨程序**
 * 設 owner 會把兩個執行緒的輸入佇列綁在一起（AttachThreadInput 的效果）——
 * 遊戲的 UI 執行緒卡住時，托盤的 UI 執行緒跟著卡。這顆鈕存在的理由就是
 * 「遊戲出事時還按得到」，不能冒這個險。
 *
 * 所以改由 helper 自己追：
 *
 * - `EVENT_OBJECT_LOCATIONCHANGE`（只聽遊戲那個程序）→ 視窗動了就跟著動
 * - `EVENT_SYSTEM_FOREGROUND`（全域）→ Z 順序變了，把鈕插回遊戲視窗正上方
 * - 每 250ms 再對一次，補漏掉的事件（全螢幕切換改的是樣式）、重取底色
 *   （前景切換時標題列的顏色是漸變的，事件當下取到的是半途的顏色）
 *
 * 位置用 `DWMWA_CAPTION_BUTTON_BOUNDS`（相對於 `GetWindowRect` 左上角）：
 * 2026-09-26 實測 1346 寬的視窗回 `1193,0,1339,30`，三顆鈕各約 48px。
 *
 * 不顯示的時候：最小化、沒有標題列（全螢幕）、視窗不見了。遊戲視窗消失
 * helper 就自己結束，托盤下次接上遊戲再開一支。
 *
 * ## 底色是從螢幕上取的
 *
 * 本來想做成透明視窗、讓底下的標題列透上來 —— 但 Chromium 會把小於 64px 的
 * 透明視窗偷偷放大（`EnableTransparentHwndEnlargement`），外面再用 SetWindowPos
 * 貼成 48×30，它算出來的大小就亂了（2026-09-26 實測 bounds 變成 30×5，什麼都
 * 看不到）。所以鈕是不透明的，底色要跟標題列一樣。
 *
 * 標題列的顏色由太多東西決定（淺／深色模式、輔色開不開、前景與否、Win10／11），
 * 猜不準。helper 直接取鈕左邊一點的像素 —— **只在那一點確實是遊戲視窗時才取**
 * （`WindowFromPoint`），被別的視窗蓋住時沿用上一次的顏色。取色只在計時器與
 * 前景切換時做，拖動視窗那一連串 LOCATIONCHANGE 不取（GetPixel 經 DWM 很慢）。
 *
 * ⚠ helper 的 C# 是 `Add-Type` 編的 —— Windows PowerShell 5.1 帶的是 C# 5 編譯器：
 *   不能用字串插值（`$"..."`）、`=>` 成員、`out var`。
 */

/** helper 回報的一行。 */
export type TitleButtonEvent =
  | {
      type: "state";
      /** 鈕現在有沒有顯示。 */
      shown: boolean;
      /** 遊戲視窗是不是前景。 */
      active: boolean;
      /** 標題列的顏色 `#rrggbb`；還沒取到是 `null`。 */
      bg: string | null;
    }
  | { type: "gone" }
  | { type: "error"; message: string };

/** `__PID__`／`__OVERLAY__` 在送出前換成真的值（`-EncodedCommand` 不好帶參數）。 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace ULR -Name TitleButton -MemberDefinition @"
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
public delegate bool EnumProc(IntPtr h, IntPtr l);
public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time);
public delegate void TimerProc(IntPtr h, uint m, IntPtr id, uint time);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
[DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, TimerProc cb);
[DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
[DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
[DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
[DllImport("user32.dll")] static extern void PostQuitMessage(int code);
[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
[DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);

static IntPtr game = IntPtr.Zero;
static IntPtr overlay = IntPtr.Zero;
static uint gamePid = 0;
static WinEventProc onEvent = OnEvent;
static TimerProc onTimer = OnTimer;
static string last = "";
static string bg = "null";

static IntPtr Find(uint pid) {
  IntPtr found = IntPtr.Zero;
  EnumWindows(delegate (IntPtr h, IntPtr l) {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
    found = h; return false;
  }, IntPtr.Zero);
  return found;
}

static void Say(string line) {
  if (line == last) return;
  last = line;
  Console.WriteLine(line);
}

static void Hide() {
  // SWP_NOSIZE 1 | SWP_NOMOVE 2 | SWP_NOZORDER 4 | SWP_NOACTIVATE 0x10 | SWP_HIDEWINDOW 0x80
  SetWindowPos(overlay, IntPtr.Zero, 0, 0, 0, 0, 0x97);
}

/** 取 (x, y) 的顏色，只在那一點是遊戲視窗時才取（GA_ROOT 2）。 */
static void Sample(int x, int y) {
  POINT p; p.X = x; p.Y = y;
  if (GetAncestor(WindowFromPoint(p), 2) != game) return;
  IntPtr dc = GetDC(IntPtr.Zero);
  uint c = GetPixel(dc, x, y);
  ReleaseDC(IntPtr.Zero, dc);
  if (c == 0xFFFFFFFF) return; // CLR_INVALID
  // COLORREF 是 0x00BBGGRR
  bg = "\"#" + (c & 0xFF).ToString("x2") + ((c >> 8) & 0xFF).ToString("x2") + ((c >> 16) & 0xFF).ToString("x2") + "\"";
}

static void Update(bool sample) {
  if (!IsWindow(game)) {
    Hide();
    Console.WriteLine("{\"type\":\"gone\"}");
    PostQuitMessage(0);
    return;
  }
  bool active = GetForegroundWindow() == game;
  string act = active ? "true" : "false";
  // WS_CAPTION 0x00C00000：全螢幕時被拿掉
  bool caption = (GetWindowLong(game, -16) & 0x00C00000) == 0x00C00000;
  RECT w, c;
  if (!IsWindowVisible(game) || IsIconic(game) || !caption
      || !GetWindowRect(game, out w) || DwmGetWindowAttribute(game, 5, out c, 16) != 0
      || c.R - c.L <= 0) {
    Hide();
    Say("{\"type\":\"state\",\"shown\":false,\"active\":" + act + ",\"bg\":" + bg + "}");
    return;
  }
  int bw = (c.R - c.L) / 3;
  int x = w.L + c.L - bw;
  int y = w.T + c.T;
  int h = c.B - c.T;
  if (sample) Sample(x - 6, y + h / 2);
  // 插在遊戲視窗正上方：放在「遊戲上面那一個」的下面。遊戲已經在最上面、或上面
  // 那個是置頂視窗（放它下面會一起被當成置頂那一層），就用 HWND_TOP。
  IntPtr prev = GetWindow(game, 3);
  // SWP_NOACTIVATE 0x10 | SWP_SHOWWINDOW 0x40 | SWP_NOSENDCHANGING 0x400
  // 最後那個不能少：送了 WM_WINDOWPOSCHANGING 的話 Windows 會拿最小視窗高度
  // （SM_CYMINTRACK，100% 是 39）把 30 高的鈕撐成 39，蓋住遊戲畫面上緣。
  uint flags = 0x450;
  if (prev == overlay) {
    flags |= 0x4; // 已經在正上方：SWP_NOZORDER
  } else if (prev == IntPtr.Zero || (GetWindowLong(prev, -20) & 0x8) != 0) {
    prev = IntPtr.Zero;
  }
  SetWindowPos(overlay, prev, x, y, bw, h, flags);
  Say("{\"type\":\"state\",\"shown\":true,\"active\":" + act + ",\"bg\":" + bg + "}");
}

static void OnEvent(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time) {
  // LOCATIONCHANGE 只看遊戲視窗本身（OBJID_WINDOW 0），游標之類的也會送這個事件
  if (ev == 0x800B && (h != game || obj != 0)) return;
  Update(ev != 0x800B);
}

static void OnTimer(IntPtr h, uint m, IntPtr id, uint time) { Update(true); }

public static void Run(uint pid, long overlayHandle) {
  // 每個螢幕各自的 DPI：不宣告的話座標是虛擬化過的，貼上去會差一個縮放倍率
  SetThreadDpiAwarenessContext(new IntPtr(-4));
  gamePid = pid;
  overlay = new IntPtr(overlayHandle);
  for (int i = 0; i < 50 && game == IntPtr.Zero; i++) {
    game = Find(pid);
    if (game == IntPtr.Zero) System.Threading.Thread.Sleep(200);
  }
  if (game == IntPtr.Zero) { Console.WriteLine("{\"type\":\"gone\"}"); return; }
  // WINEVENT_OUTOFCONTEXT 0：回呼走這條執行緒的訊息迴圈
  SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, onEvent, 0, 0, 0);          // FOREGROUND（全域）
  SetWinEventHook(0x0016, 0x0017, IntPtr.Zero, onEvent, gamePid, 0, 0);    // MINIMIZESTART/END
  SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, onEvent, gamePid, 0, 0);    // LOCATIONCHANGE
  SetTimer(IntPtr.Zero, IntPtr.Zero, 250, onTimer);
  Update(true);
  MSG msg;
  while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
  Hide();
}
"@
try {
  [ULR.TitleButton]::Run([uint32]__PID__, [int64]__OVERLAY__)
} catch {
  $m = ($_.Exception.Message -replace '[\\"]', ' ' -replace '\s+', ' ')
  [Console]::WriteLine('{"type":"error","message":"' + $m + '"}')
}
`;

/** 組出要丟給 `powershell -EncodedCommand` 的腳本。 */
export function buildTitleButtonScript(pid: number, overlayHandle: bigint): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid 不合法：${pid}`);
  if (overlayHandle <= 0n) throw new Error("鈕的視窗 handle 不合法");
  return SCRIPT.replace("__PID__", String(pid)).replace("__OVERLAY__", overlayHandle.toString());
}

/** 讀 helper 印出來的一行。讀不懂回 `null`（PowerShell 偶爾會吐別的東西）。 */
export function parseTitleButtonLine(line: string): TitleButtonEvent | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (o["type"]) {
    case "state": {
      const bg = o["bg"];
      return {
        type: "state",
        shown: o["shown"] === true,
        active: o["active"] === true,
        bg: typeof bg === "string" && /^#[0-9a-f]{6}$/i.test(bg) ? bg.toLowerCase() : null,
      };
    }
    case "gone":
      return { type: "gone" };
    case "error":
      return { type: "error", message: typeof o["message"] === "string" ? o["message"] : "" };
    default:
      return null;
  }
}

/** 鈕的樣子。照 Windows 標題列按鈕：底色跟標題列一樣，滑過疊一層半透明。 */
export interface TitleButtonLook {
  bg: string;
  glyph: string;
  hover: string;
  press: string;
}

/** 還沒取到顏色時先用的底色（深色模式、不在前景的標題列）。 */
export const FALLBACK_TITLE_BG = "#2b2b2b";

/**
 * 照標題列的顏色挑圖示顏色：深底白字、淺底黑字；不在前景時變灰，跟旁邊三顆一樣。
 */
export function titleButtonLook(bg: string | null, active: boolean): TitleButtonLook {
  const base = bg ?? FALLBACK_TITLE_BG;
  if (isDark(base)) {
    return {
      bg: base,
      glyph: active ? "#ffffff" : "#8c8c8c",
      hover: "rgba(255,255,255,0.1)",
      press: "rgba(255,255,255,0.2)",
    };
  }
  return {
    bg: base,
    glyph: active ? "#000000" : "#999999",
    hover: "rgba(0,0,0,0.1)",
    press: "rgba(0,0,0,0.2)",
  };
}

/** 感知亮度（ITU-R 601 係數），夠用來挑黑白字。 */
function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}
