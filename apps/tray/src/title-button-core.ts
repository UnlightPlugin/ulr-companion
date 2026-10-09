/**
 * 遊戲視窗標題列上的「重新整理」鈕 —— 不碰 Electron 的部分
 * ======================================================
 * 玩家 2026-09-26：「重新載入不方便，也常常被蓋住不能按」—— 遊戲裡的東西會被
 * 面板蓋住、白畫面時根本沒有東西可按。要一顆**永遠按得到**的。
 *
 * 做法：一支常駐的 PowerShell（C#）自己開一個很小的原生視窗，貼在遊戲視窗的
 * 「最小化」左邊。它是另一個程序的另一個視窗，遊戲畫面怎樣都蓋不到它；按下去
 * helper 印一行 `click`，托盤走 CDP 對外殼 `Page.reload`，白畫面、斷線照樣有效。
 *
 * ## 為什麼不用 Electron 的視窗畫
 *
 * 原本鈕是托盤開的 BrowserWindow，helper 只負責搬它。2026-09-27 與 10-05 兩次
 * 休眠醒來後，那個小視窗的 Chromium 不再出畫面：顏色與圖示停住、點擊也到不了
 * 頁面（記錄裡一次按鈕都沒有）。第一次加了「醒來 3 秒後整個重建」，第二次重建
 * 出來的新視窗照樣凍住 —— 猜不到 GPU 什麼時候準備好。所以改成 helper 自己用
 * GDI+ 畫：WM_PAINT 每次都是同步畫在視窗上，沒有合成器可以掛。
 *
 * ## 為什麼不把它設成遊戲視窗的 owned window
 *
 * owned window 會自動跟著主視窗的 Z 順序、最小化，看起來最省事。但**跨程序**
 * 設 owner 會把兩個執行緒的輸入佇列綁在一起（AttachThreadInput 的效果）——
 * 遊戲的 UI 執行緒卡住時，鈕的執行緒跟著卡。這顆鈕存在的理由就是
 * 「遊戲出事時還按得到」，不能冒這個險。
 *
 * 所以改由 helper 自己追：
 *
 * - `EVENT_OBJECT_LOCATIONCHANGE`（只聽遊戲那個程序）→ 視窗動了就跟著動
 * - `EVENT_SYSTEM_FOREGROUND`（全域）→ Z 順序變了，把鈕插回遊戲視窗正上方
 * - 每 250ms 再對一次，補漏掉的事件（全螢幕切換改的是樣式）、重取底色
 *   （前景切換時標題列的顏色是漸變的，事件當下取到的是半途的顏色）
 *
 * 插完要檢查有沒有真的插上去：helper 是背景程序，Windows 不讓它把視窗往上抬過
 * 前景視窗，而且 SetWindowPos 照樣回成功。插不上就先置頂再取消置頂繞過去（`Lift`）。
 *
 * 位置用 `DWMWA_CAPTION_BUTTON_BOUNDS`（相對於 `GetWindowRect` 左上角）：
 * 2026-09-26 實測 1346 寬的視窗回 `1193,0,1339,30`，三顆鈕各約 48px。
 *
 * 不顯示的時候：最小化、沒有標題列（全螢幕）、視窗不見了。遊戲視窗消失
 * helper 就自己結束，托盤下次接上遊戲再開一支。
 *
 * ## 底色是從螢幕上取的
 *
 * 鈕是不透明的，底色要跟標題列一樣。（還在用 Electron 時是不得不：Chromium 會把
 * 小於 64px 的透明視窗偷偷放大，貼成 48×30 就算錯。）
 *
 * 標題列的顏色由太多東西決定（淺／深色模式、輔色開不開、前景與否、Win10／11），
 * 猜不準。helper 直接取鈕左邊一點的像素 —— **只在那一點確實是遊戲視窗時才取**
 * （`WindowFromPoint`），被別的視窗蓋住時沿用上一次的顏色。取色只在計時器與
 * 前景切換時做，拖動視窗那一連串 LOCATIONCHANGE 不取（GetPixel 經 DWM 很慢）。
 *
 * ## 鈕的樣子
 *
 * 照 Windows 標題列按鈕：圖示是 Segoe MDL2 Assets 的 U+E72C、10px（隨 DPI 放大）；
 * 深底白字、淺底黑字，不在前景時變灰；滑過疊 10% 白／黑，按住 20%。按下去轉一圈，
 * 3 秒內再按不理（連點保護也在 helper 裡，托盤收到 `click` 就直接重新整理）。
 * 視窗是 WS_EX_NOACTIVATE＋回 MA_NOACTIVATE：按它不會讓遊戲視窗失去前景。
 *
 * ⚠ helper 的 C# 是 `Add-Type` 編的 —— Windows PowerShell 5.1 帶的是 C# 5 編譯器：
 *   不能用字串插值（`$"..."`）、`=>`、`out var`、`?.`、`nameof`。
 *   字串裡的非 ASCII 字用 `(char)0x91CD` 這樣組（原始碼經暫存檔編譯，編碼不保證；
 *   註解亂掉無妨）。也別寫反斜線 u 跳脫：編輯工具會把它解成真的字，私用區的圖示字
 *   還是看不見的，測試擋著。
 */

/** helper 回報的一行。 */
export type TitleButtonEvent =
  { type: "click" } | { type: "gone" } | { type: "error"; message: string };

/** `__PID__` 在送出前換成真的值（`-EncodedCommand` 不好帶參數）。 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace ULR -Name TitleButton -ReferencedAssemblies System.Drawing -UsingNamespace System.Drawing,System.Drawing.Drawing2D,System.Drawing.Imaging -MemberDefinition @"
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
[StructLayout(LayoutKind.Sequential)] public struct PAINTSTRUCT { public IntPtr hdc; public int fErase; public RECT rc; public int fRestore; public int fIncUpdate; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] reserved; }
[StructLayout(LayoutKind.Sequential)] public struct TRACKMOUSEEVENT { public uint cbSize; public uint dwFlags; public IntPtr hwndTrack; public uint dwHoverTime; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct WNDCLASSEX { public uint cbSize; public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm; }
// 到 lParam 為止（TTTOOLINFOW_V2_SIZE）：powershell.exe 沒有 manifest，載的是 comctl32 v5
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct TOOLINFO { public uint cbSize; public uint uFlags; public IntPtr hwnd; public IntPtr uId; public RECT rect; public IntPtr hinst; public string lpszText; public IntPtr lParam; }
public delegate bool EnumProc(IntPtr h, IntPtr l);
public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time);
public delegate void TimerProc(IntPtr h, uint m, IntPtr id, uint time);
public delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
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
[DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
[DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
[DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, TimerProc cb);
[DllImport("user32.dll")] static extern bool KillTimer(IntPtr h, IntPtr id);
[DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
[DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
[DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
[DllImport("user32.dll")] static extern void PostQuitMessage(int code);
[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassExW(ref WNDCLASSEX wc);
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
[DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] static extern IntPtr LoadCursorW(IntPtr inst, IntPtr id);
[DllImport("user32.dll")] static extern IntPtr BeginPaint(IntPtr h, out PAINTSTRUCT ps);
[DllImport("user32.dll")] static extern bool EndPaint(IntPtr h, ref PAINTSTRUCT ps);
[DllImport("user32.dll")] static extern bool InvalidateRect(IntPtr h, IntPtr r, bool erase);
[DllImport("user32.dll")] static extern bool TrackMouseEvent(ref TRACKMOUSEEVENT t);
[DllImport("user32.dll")] static extern IntPtr SetCapture(IntPtr h);
[DllImport("user32.dll")] static extern bool ReleaseCapture();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, ref TOOLINFO l);
[DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(IntPtr name);
[DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);

static IntPtr game = IntPtr.Zero;
static IntPtr overlay = IntPtr.Zero;
static uint gamePid = 0;
static WinEventProc onEvent = OnEvent;
static TimerProc onTimer = OnTimer;
static WndProc wndProc = Proc;
/** 標題列的顏色 0xRRGGBB；還沒取到是 -1。 */
static int bgRgb = -1;
static bool active = false;
static int paintedRgb = -2;
static bool paintedActive = false;
static bool hover = false;
static bool pressed = false;
static bool clicked = false;
static int lastClick = 0;
static bool lifted = false;
static int lastLift = 0;
static bool spinning = false;
static int spinStart = 0;
static GraphicsPath glyph = null;
static uint glyphDpi = 0;

const int COOLDOWN_MS = 3000;
const int SPIN_MS = 600;
static readonly IntPtr SPIN_TIMER = new IntPtr(1);

static IntPtr Find(uint pid) {
  IntPtr found = IntPtr.Zero;
  EnumWindows(delegate (IntPtr h, IntPtr l) {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
    found = h; return false;
  }, IntPtr.Zero);
  return found;
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
  bgRgb = (int)(((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF));
}

static void Update(bool sample) {
  if (!IsWindow(game)) {
    Hide();
    Console.WriteLine("{\"type\":\"gone\"}");
    PostQuitMessage(0);
    return;
  }
  active = GetForegroundWindow() == game;
  // WS_CAPTION 0x00C00000：全螢幕時被拿掉
  bool caption = (GetWindowLong(game, -16) & 0x00C00000) == 0x00C00000;
  RECT w, c;
  if (!IsWindowVisible(game) || IsIconic(game) || !caption
      || !GetWindowRect(game, out w) || DwmGetWindowAttribute(game, 5, out c, 16) != 0
      || c.R - c.L <= 0) {
    Hide();
    return;
  }
  int bw = (c.R - c.L) / 3;
  int x = w.L + c.L - bw;
  int y = w.T + c.T;
  int h = c.B - c.T;
  if (sample) Sample(x - 6, y + h / 2);
  // SWP_NOACTIVATE 0x10 | SWP_SHOWWINDOW 0x40 | SWP_NOSENDCHANGING 0x400
  // 最後那個不能少：送了 WM_WINDOWPOSCHANGING 的話 Windows 會拿最小視窗高度
  // （SM_CYMINTRACK，100% 是 39）把 30 高的鈕撐成 39，蓋住遊戲畫面上緣。
  uint flags = 0x450;
  bool placed = Placed();
  IntPtr prev = IntPtr.Zero;
  if (placed) flags |= 0x4; // 已經在正上方：SWP_NOZORDER
  else prev = Above();
  SetWindowPos(overlay, prev, x, y, bw, h, flags);
  if (!placed && !Placed()) Lift(prev);
  // 大小變了 CS_HREDRAW／CS_VREDRAW 會自己重畫；顏色變了要自己叫
  if (bgRgb != paintedRgb || active != paintedActive) InvalidateRect(overlay, IntPtr.Zero, false);
}

/**
 * 鈕是不是已經在遊戲正上方。中間隔著看不見的視窗不算（遊戲與鈕自己的 IME 視窗、
 * 收起來的提示框都排在旁邊）。
 */
static bool Placed() {
  for (IntPtr h = GetWindow(game, 3); h != IntPtr.Zero; h = GetWindow(h, 3)) {
    if (h == overlay) return true;
    if (IsWindowVisible(h)) return false;
  }
  return false;
}

/**
 * 插在遊戲正上方要「放在誰的下面」：遊戲上面第一個看得到的視窗。不直接用遊戲上面
 * 那一個：那通常是遊戲自己的 IME 視窗（看不見、被遊戲 own），插在它後面不可靠。
 * 上面沒有一般視窗、或碰到的是置頂視窗（放它下面會一起被當成置頂那一層），回
 * Zero 用 HWND_TOP。
 */
static IntPtr Above() {
  for (IntPtr h = GetWindow(game, 3); h != IntPtr.Zero; h = GetWindow(h, 3)) {
    if (h == overlay || !IsWindowVisible(h)) continue;
    return (GetWindowLong(h, -20) & 0x8) != 0 ? IntPtr.Zero : h;
  }
  return IntPtr.Zero;
}

/**
 * 一般的插法沒插上去時用：先置頂、再取消置頂，落在一般視窗的最上面，再往下插到
 * 遊戲上方。
 *
 * 背景程序把視窗往上抬會被 Windows 安靜擋掉 —— SetWindowPos 回成功，Z 順序一動
 * 也不動（往下放不受限）。實測越過前景視窗一定被擋；剛開的程序不受限，跑久了才會
 * 卡（測試裡跑 4 分鐘的 helper 也自己卡過一次）。2026-10-07 休眠醒來後鈕排在遊戲
 * 後面 16 層，15 小時每一拍都插不上，畫面上就是鈕不見了。置頂與取消置頂不受這條
 * 限制（實測）。限 1 秒一次：真的插不上時不要一直閃。
 */
static void Lift(IntPtr prev) {
  int now = Environment.TickCount;
  if (lifted && now - lastLift < 1000) return;
  lifted = true;
  lastLift = now;
  // SWP_NOSIZE 1 | SWP_NOMOVE 2 | SWP_NOACTIVATE 0x10 | SWP_NOSENDCHANGING 0x400
  SetWindowPos(overlay, new IntPtr(-1), 0, 0, 0, 0, 0x413); // HWND_TOPMOST
  SetWindowPos(overlay, new IntPtr(-2), 0, 0, 0, 0, 0x413); // HWND_NOTOPMOST：落在一般視窗最上面
  if (prev != IntPtr.Zero) SetWindowPos(overlay, prev, 0, 0, 0, 0, 0x413);
}

static void OnEvent(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time) {
  // LOCATIONCHANGE 只看遊戲視窗本身（OBJID_WINDOW 0），游標之類的也會送這個事件
  if (ev == 0x800B && (h != game || obj != 0)) return;
  Update(ev != 0x800B);
}

static void OnTimer(IntPtr h, uint m, IntPtr id, uint time) { Update(true); }

static void Click() {
  int now = Environment.TickCount;
  if (clicked && now - lastClick < COOLDOWN_MS) return;
  clicked = true;
  lastClick = now;
  Console.WriteLine("{\"type\":\"click\"}");
  spinning = true;
  spinStart = now;
  SetTimer(overlay, SPIN_TIMER, 15, null);
}

static bool Inside(IntPtr h, IntPtr l) {
  long v = l.ToInt64();
  int x = (short)(v & 0xFFFF), y = (short)((v >> 16) & 0xFFFF);
  RECT r; GetClientRect(h, out r);
  return x >= r.L && x < r.R && y >= r.T && y < r.B;
}

static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) {
  switch (m) {
    case 0x000F: { // WM_PAINT
      PAINTSTRUCT ps;
      IntPtr dc = BeginPaint(h, out ps);
      try { Paint(dc); } catch (Exception) { }
      EndPaint(h, ref ps);
      return IntPtr.Zero;
    }
    case 0x0014: return new IntPtr(1); // WM_ERASEBKGND：整塊自己畫，不先塗白
    case 0x0021: return new IntPtr(3); // WM_MOUSEACTIVATE → MA_NOACTIVATE
    case 0x0200: { // WM_MOUSEMOVE
      bool inside = Inside(h, l);
      if (inside && !hover) {
        TRACKMOUSEEVENT t = new TRACKMOUSEEVENT();
        t.cbSize = (uint)Marshal.SizeOf(typeof(TRACKMOUSEEVENT));
        t.dwFlags = 2; // TME_LEAVE
        t.hwndTrack = h;
        TrackMouseEvent(ref t);
      }
      if (inside != hover) { hover = inside; InvalidateRect(h, IntPtr.Zero, false); }
      return IntPtr.Zero;
    }
    case 0x02A3: // WM_MOUSELEAVE
      if (!pressed) { hover = false; InvalidateRect(h, IntPtr.Zero, false); }
      return IntPtr.Zero;
    case 0x0201: // WM_LBUTTONDOWN
      pressed = true;
      hover = true;
      SetCapture(h);
      InvalidateRect(h, IntPtr.Zero, false);
      return IntPtr.Zero;
    case 0x0202: { // WM_LBUTTONUP
      bool was = pressed;
      bool inside = Inside(h, l);
      pressed = false;
      hover = inside;
      ReleaseCapture();
      if (was && inside) Click();
      InvalidateRect(h, IntPtr.Zero, false);
      return IntPtr.Zero;
    }
    case 0x0215: // WM_CAPTURECHANGED
      if (pressed) { pressed = false; InvalidateRect(h, IntPtr.Zero, false); }
      return IntPtr.Zero;
    case 0x0113: // WM_TIMER
      if (w == SPIN_TIMER) {
        if (Environment.TickCount - spinStart >= SPIN_MS) { spinning = false; KillTimer(h, SPIN_TIMER); }
        InvalidateRect(h, IntPtr.Zero, false);
        return IntPtr.Zero;
      }
      break;
  }
  return DefWindowProcW(h, m, w, l);
}

static int Mix(int c, int to, double a) { return (int)Math.Round(c + (to - c) * a); }

/** U+E72C 的外框，以字形本身的中心為原點（轉圈繞著它轉）。換 DPI 才重算。 */
static GraphicsPath Glyph() {
  uint dpi = 96;
  try { dpi = GetDpiForWindow(overlay); } catch (EntryPointNotFoundException) { }
  if (dpi == 0) dpi = 96;
  if (glyph != null && glyphDpi == dpi) return glyph;
  FontFamily family = null;
  foreach (string name in new string[] { "Segoe MDL2 Assets", "Segoe Fluent Icons" }) {
    try { family = new FontFamily(name); break; } catch (ArgumentException) { }
  }
  if (family == null) return null;
  GraphicsPath p = new GraphicsPath();
  p.AddString(((char)0xE72C).ToString(), family, 0, 10f * dpi / 96f, new PointF(0, 0), StringFormat.GenericTypographic);
  family.Dispose();
  RectangleF b = p.GetBounds();
  using (Matrix mx = new Matrix()) {
    mx.Translate(-(b.X + b.Width / 2f), -(b.Y + b.Height / 2f));
    p.Transform(mx);
  }
  if (glyph != null) glyph.Dispose();
  glyph = p;
  glyphDpi = dpi;
  return p;
}

static void Paint(IntPtr dc) {
  RECT r; GetClientRect(overlay, out r);
  int w = r.R - r.L, h = r.B - r.T;
  if (w <= 0 || h <= 0) return;
  int rgb = bgRgb < 0 ? 0x2b2b2b : bgRgb;
  int cr = (rgb >> 16) & 0xFF, cg = (rgb >> 8) & 0xFF, cb = rgb & 0xFF;
  // 感知亮度（ITU-R 601 係數），夠用來挑黑白字
  bool dark = 0.299 * cr + 0.587 * cg + 0.114 * cb < 140;
  int tint = dark ? 255 : 0;
  double a = pressed && hover ? 0.2 : hover ? 0.1 : 0;
  Color fill = Color.FromArgb(Mix(cr, tint, a), Mix(cg, tint, a), Mix(cb, tint, a));
  Color ink = dark
    ? (active ? Color.FromArgb(255, 255, 255) : Color.FromArgb(0x8c, 0x8c, 0x8c))
    : (active ? Color.FromArgb(0, 0, 0) : Color.FromArgb(0x99, 0x99, 0x99));
  GraphicsPath path = Glyph();
  using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppPArgb)) {
    using (Graphics g = Graphics.FromImage(bmp)) {
      g.Clear(fill);
      if (path != null) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TranslateTransform(w / 2f, h / 2f);
        if (spinning) g.RotateTransform(360f * Math.Min(SPIN_MS, Environment.TickCount - spinStart) / SPIN_MS);
        using (SolidBrush brush = new SolidBrush(ink)) g.FillPath(brush, path);
      }
    }
    using (Graphics screen = Graphics.FromHdc(dc)) screen.DrawImageUnscaled(bmp, 0, 0);
  }
  paintedRgb = bgRgb;
  paintedActive = active;
}

static IntPtr CreateOverlay() {
  IntPtr inst = GetModuleHandleW(IntPtr.Zero);
  WNDCLASSEX wc = new WNDCLASSEX();
  wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
  wc.style = 3; // CS_HREDRAW | CS_VREDRAW
  wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(wndProc);
  wc.hInstance = inst;
  wc.hCursor = LoadCursorW(IntPtr.Zero, new IntPtr(32512)); // IDC_ARROW
  wc.lpszClassName = "ULRTitleButton";
  RegisterClassExW(ref wc);
  // WS_EX_NOACTIVATE 0x08000000（按它不搶前景）| WS_EX_TOOLWINDOW 0x80（不進工作列、Alt+Tab）；WS_POPUP
  IntPtr h = CreateWindowExW(0x08000080, "ULRTitleButton", "", 0x80000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
  if (h == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  // 滑過的提示。TTS_ALWAYSTIP 1 | TTS_NOPREFIX 2：鈕永遠不是前景，沒有 ALWAYSTIP 不會出來
  int cw = unchecked((int)0x80000000); // CW_USEDEFAULT
  IntPtr tip = CreateWindowExW(0x8, "tooltips_class32", null, 0x80000003, cw, cw, cw, cw, h, IntPtr.Zero, inst, IntPtr.Zero);
  if (tip != IntPtr.Zero) {
    TOOLINFO ti = new TOOLINFO();
    ti.cbSize = (uint)Marshal.SizeOf(typeof(TOOLINFO));
    ti.uFlags = 0x11; // TTF_IDISHWND | TTF_SUBCLASS
    ti.hwnd = h;
    ti.uId = h;
    // 重新整理遊戲
    ti.lpszText = new string(new char[] { (char)0x91CD, (char)0x65B0, (char)0x6574, (char)0x7406, (char)0x904A, (char)0x6232 });
    SendMessageW(tip, 0x0432, IntPtr.Zero, ref ti); // TTM_ADDTOOLW
  }
  return h;
}

public static void Run(uint pid) {
  // 每個螢幕各自的 DPI：不宣告的話座標是虛擬化過的，貼上去會差一個縮放倍率。
  // 要在開視窗之前：視窗的 DPI 模式跟著建立它那時的執行緒走。
  SetThreadDpiAwarenessContext(new IntPtr(-4));
  gamePid = pid;
  for (int i = 0; i < 50 && game == IntPtr.Zero; i++) {
    game = Find(pid);
    if (game == IntPtr.Zero) System.Threading.Thread.Sleep(200);
  }
  if (game == IntPtr.Zero) { Console.WriteLine("{\"type\":\"gone\"}"); return; }
  overlay = CreateOverlay();
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
  [ULR.TitleButton]::Run([uint32]__PID__)
} catch {
  $m = ($_.Exception.Message -replace '[\\"]', ' ' -replace '\s+', ' ')
  [Console]::WriteLine('{"type":"error","message":"' + $m + '"}')
}
`;

/** 組出 helper 的腳本。 */
export function buildTitleButtonScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid 不合法：${pid}`);
  return SCRIPT.replace("__PID__", String(pid));
}

/**
 * 命令列只放一小段開機碼，主腳本從 stdin 送進去。
 *
 * ⚠ 主腳本不能直接塞 `-EncodedCommand`：UTF-16 再 base64 要乘 2.7 倍，自己畫鈕
 * 之後超過 Windows 命令列 32767 字的上限，spawn 直接 ENAMETOOLONG。stdin 也用
 * base64 傳：管線預設是 ANSI 字碼頁，中文註解會變亂碼。
 */
const BOOTSTRAP =
  "$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); " +
  "Invoke-Expression $s";

/** 開 helper 要用的參數與要寫進 stdin（寫完就關）的內容。 */
export function titleButtonLaunch(pid: number): { args: string[]; stdin: string } {
  const script = buildTitleButtonScript(pid);
  return {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(BOOTSTRAP, "utf16le").toString("base64"),
    ],
    stdin: Buffer.from(script, "utf8").toString("base64"),
  };
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
    case "click":
      return { type: "click" };
    case "gone":
      return { type: "gone" };
    case "error":
      return { type: "error", message: typeof o["message"] === "string" ? o["message"] : "" };
    default:
      return null;
  }
}
