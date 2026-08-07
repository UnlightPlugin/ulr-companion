/**
 * 托盤圖示（現畫的，不放二進位檔進版控）
 * ========================================
 * 圖示的顏色**就是狀態**，跟遊戲裡 OK 鈕的琥珀色是同一套語意
 * （`docs/handoff-wp12.md`：顏色代表「插件現在有沒有在管」）：
 *
 *     灰   連不上遊戲，或攔截還沒掛上 —— 插件現在沒在管
 *     琥珀 接上了，但側通道還沒配到對手（單邊模式，秒數不縮短）
 *     綠   配對成功，約定秒數生效中
 *
 * ⚠ **不要把「已連線」畫成綠色。** 綠色必須留給「兩邊真的講好了」，
 * 因為那是唯一會讓對手的時間也被縮短的狀態。玩家從系統列一眼就要能分辨
 * 「我以為在生效」跟「真的在生效」—— 這兩者搞混的代價是他以為對手也被
 * 縮到 15 秒，結果只有自己提早承諾。
 *
 * 為什麼是自己編碼 PNG 而不是放一個 .png 檔：托盤圖示要隨狀態換三種顏色，
 * 而且之後可能要跟著 DPI 換尺寸。三個檔案 + 建置流程要把它們複製到 dist，
 * 比 40 行的編碼器麻煩得多，而且會多一個「檔案沒被打包進去」的失敗模式。
 */

import { deflateSync } from "node:zlib";

export type IconState = "idle" | "solo" | "paired";

const COLORS: Record<IconState, [number, number, number]> = {
  idle: [0x88, 0x8c, 0x94],
  solo: [0xff, 0xc2, 0x47], // 跟遊戲裡 OK 鈕的琥珀色同一個值
  paired: [0x4c, 0xc9, 0x6a],
};

/** 托盤圖示的邊長。Windows 的系統列用 16，畫大一點在高 DPI 下比較不糊。 */
export const TRAY_SIZE = 32;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * 圖案：**深色圓底 + 狀態色的雙臂漩渦。**
 *
 * 漩渦是自己畫的原創標記（一條純數學的阿基米德螺線），不是任何遊戲素材。
 * 選它的理由是「渦」本來就是這個插件的六個大分頁之一，而漩渦這個形狀在小尺寸
 * 下辨識度比幾何塊面高得多 —— 它有旋轉方向，眼睛一眼就抓得到。
 *
 * ⚠ **不要改成用官方美術。** icon 是這個工具的身分 —— 掛上官方的圖等於宣稱
 * 自己是官方出品，而這個專案的整個立場是「不碰伺服器、雙方同意才生效」。
 * 那條線上最不該讓人誤會的就是這個。（同理見 renderer/index.html 的檔頭：
 * 畫面也是純 CSS 重現，repo 裡沒有任何遊戲圖檔。）
 *
 * ⚠ **狀態色仍然是主訊號**，形狀只是身分。16px 下漩渦的圈數幾乎數不出來，
 * 玩家真正讀的是顏色 —— 所以底色要夠深，讓三種狀態色在淺色與深色工作列上
 * 都浮得出來。
 */
const DISC: [number, number, number] = [0x14, 0x0b, 0x0d]; // 近黑，帶一點紅

/** 漩渦有幾條臂。2 條在 16px 下還數得出來，3 條就糊成一團了。 */
const ARMS = 2;

/**
 * 螺線的鬆緊：從中心到邊緣繞幾圈。
 *
 * 1.25 圈是實際看出來的：再緊會在小尺寸下變成同心圓（看不出旋轉方向），
 * 再鬆就只剩兩條直線，不像漩渦。
 */
const TURNS = 1.25;

/**
 * 畫圖示，回傳 PNG 的 bytes。
 *
 * 邊緣用覆蓋率當 alpha 做反鋸齒。**螺線的兩側也要**，不然 32px 下那兩條臂會
 * 變成階梯狀的鋸齒 —— 圓外緣還可以忍，臂的邊緣不行，它佔的面積大得多。
 */
export function trayIconPng(state: IconState, size: number = TRAY_SIZE): Buffer {
  const SIZE = Math.max(8, Math.trunc(size));
  const [r, g, b] = COLORS[state];
  const [dr, dg, db] = DISC;
  const centre = (SIZE - 1) / 2;
  /** 圓的半徑。留 1px 邊界避免被裁到。 */
  const radius = SIZE / 2 - 1;
  /** 一個像素對應多少「螺線相位」—— 反鋸齒的寬度要用它換算。 */
  const phasePerPx = (ARMS * TURNS) / radius;

  // PNG 的每一列前面要有一個 filter byte（0 = None）。
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let at = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[at++] = 0;
    for (let x = 0; x < SIZE; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const dist = Math.hypot(dx, dy);

      // 圓外緣：從 radius-1 到 radius 線性淡出。
      const discCov = Math.max(0, Math.min(1, radius - dist));

      /**
       * 阿基米德螺線：相位 = 角度 × 臂數 + 半徑 × 鬆緊度。
       * 取小數部分之後，`< 0.5` 的那半就是臂，另外半是底 —— 兩者寬度相同，
       * 所以看起來是等寬的漩渦而不是細線。
       */
      const angle = Math.atan2(dy, dx) / (Math.PI * 2); // -0.5 ~ 0.5
      const phase = angle * ARMS + (dist / radius) * ARMS * TURNS;
      const frac = phase - Math.floor(phase);
      // 到最近的臂邊界還有多遠（相位單位），換算成像素之後做反鋸齒。
      const edge = Math.min(frac, Math.abs(0.5 - frac), 1 - frac) / phasePerPx;
      let armCov = frac < 0.5 ? Math.min(1, edge + 0.5) : Math.max(0, 0.5 - edge);

      // ⚠ 正中心的角度是沒有定義的（atan2(0,0)），相位會亂跳而閃出雜點。
      // 半徑 1px 以內直接填滿狀態色，讓漩渦有一個乾淨的核心。
      if (dist < 1) armCov = 1;

      raw[at++] = Math.round(dr + (r - dr) * armCov);
      raw[at++] = Math.round(dg + (g - dg) * armCov);
      raw[at++] = Math.round(db + (b - db) * armCov);
      raw[at++] = Math.round(discCov * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  // 10~12：compression / filter / interlace，全部是 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
