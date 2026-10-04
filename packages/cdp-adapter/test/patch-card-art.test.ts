/**
 * 卡面替換
 *
 * 跟其他 patch 一樣：搭一個夠像的假 Phaser，把產出來的**那一串字**原封不動
 * `new Function` 起來跑。形狀照 2026-09-15 在桌面版讀的，圖集名與卡面物件照
 * 2026-09-26 改版後讀的：
 *
 * ```js
 *   textures.get("CharaCardImages") → Texture { source: [TextureSource×5], frames: {name: Frame}, frameTotal }
 *   tex.get(name) → Frame（不存在時回 __BASE）；tex.has(name)
 *   tex.add(name, sourceIndex, x, y, w, h) → Frame（名字已存在回 null）
 *   new Phaser.Textures.TextureSource(tex, img, w, h)
 *   rexUI.add.circleMaskImage(x, y, "CharaCardImages", name, {maskType:"roundRectangle", radius:4})
 *     → { type: "rexCircleMaskImage", _textureKey, _frameName, setTexture(key, name, cfg) }
 * ```
 *
 * 這支要抓的坑：
 *
 * 1. 圖集還沒載時不動，載了之後自己換上
 * 2. 換上 = 格子指到新 source，已經畫在畫面上的物件（含 Container 裡的）跟著換；
 *    官方卡面是 circleMaskImage，要照官方遮罩參數重畫
 * 3. 比例不對的拒絕、等比例放大的收；圖集沒有的格子回報失敗
 * 4. 重裝 = 先還原再換；拆掉 = 原本的 Frame 放回去、多加的 source 銷毀
 * 5. 改版前的 `cc_front` 不理（改版後就是它不存在害卡面一直沒換）
 */

import { describe, expect, it } from "vitest";
import {
  buildCardArtPatchScript,
  CARD_ART_STATUS_EXPRESSION,
  CARD_ART_UNINSTALL_EXPRESSION,
  isCardArtReport,
  parseCardArtStatus,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";

class Frame {
  constructor(
    readonly texture: Texture,
    readonly name: string,
    readonly sourceIndex: number,
    readonly width: number,
    readonly height: number,
  ) {}
}

class TextureSource {
  destroyed = false;
  constructor(
    readonly texture: Texture,
    readonly image: unknown,
    readonly width: number,
    readonly height: number,
  ) {}
  destroy(): void {
    this.destroyed = true;
  }
}

class Texture {
  source: TextureSource[] = [];
  frames: Record<string, Frame> = {};
  frameTotal = 0;
  constructor(readonly key: string) {
    this.source.push(new TextureSource(this, "atlas", 6720, 3840));
    this.add("__BASE", 0, 0, 0, 6720, 3840);
  }
  add(
    name: string,
    sourceIndex: number,
    _x: number,
    _y: number,
    w: number,
    h: number,
  ): Frame | null {
    if (name in this.frames) return null;
    const f = new Frame(this, name, sourceIndex, w, h);
    this.frames[name] = f;
    this.frameTotal++;
    return f;
  }
  has(name: string): boolean {
    return name in this.frames;
  }
  get(name: string): Frame {
    return this.frames[name] ?? (this.frames["__BASE"] as Frame);
  }
}

class GameImage {
  frame: Frame;
  constructor(
    readonly texture: Texture,
    name: string,
  ) {
    this.frame = texture.get(name);
  }
  setFrame(name: string): this {
    this.frame = this.texture.get(name);
    return this;
  }
}

/** 官方卡面：把那一格複製進自己的 canvas。`drawn` 記最後一次畫進去的是哪個 Frame。 */
class CircleMaskImage {
  readonly type = "rexCircleMaskImage";
  _textureKey = "";
  _frameName = "";
  drawn: Frame | null = null;
  cfg: unknown = null;
  constructor(
    private readonly textures: Map<string, Texture>,
    key: string,
    name: string,
  ) {
    this.setTexture(key, name, { maskType: "roundRectangle", radius: 4 });
  }
  setTexture(key: string, name: string, cfg: unknown): this {
    this._textureKey = key;
    this._frameName = name;
    this.cfg = cfg;
    this.drawn = this.textures.get(key)?.get(name) ?? null;
    return this;
  }
}

interface FakeImg {
  width: number;
  height: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

function makeEnv() {
  const textures = new Map<string, Texture>();
  const sceneList: { children: { list: unknown[] } }[] = [
    { children: { list: [] } },
    { children: { list: [] } },
  ];
  const images: FakeImg[] = [];
  /** dataUrl 尾巴帶尺寸：data:image/png;base64,WxH */
  const sizeOf = (src: string): [number, number] | null => {
    const m = /,(\d+)x(\d+)$/.exec(src);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const reports: unknown[] = [];
  const intervals: (() => void)[] = [];
  const win: Record<string, unknown> = {
    game: {
      textures: {
        exists: (k: string) => textures.has(k),
        get: (k: string) => textures.get(k),
      },
      scene: { scenes: sceneList },
    },
    [BINDING]: (s: string) => reports.push(JSON.parse(s)),
  };
  class ImageCtor implements FakeImg {
    width = 0;
    height = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    #src = "";
    constructor() {
      images.push(this);
    }
    get src() {
      return this.#src;
    }
    set src(v: string) {
      this.#src = v;
      const s = sizeOf(v);
      if (s) [this.width, this.height] = s;
    }
  }
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "",
    }),
  });
  const run = (src: string): string =>
    // eslint-disable-next-line no-new-func
    new Function(
      "window",
      "Phaser",
      "Image",
      "document",
      "setInterval",
      "clearInterval",
      `return ${src};`,
    )(
      win,
      { Textures: { TextureSource } },
      ImageCtor,
      { createElement: canvas },
      (fn: () => void) => {
        intervals.push(fn);
        return intervals.length;
      },
      (id: number) => {
        intervals[id - 1] = () => {};
      },
    ) as string;
  const decodeAll = () => {
    for (const img of images.splice(0)) {
      if (sizeOf(img.src)) img.onload?.();
      else img.onerror?.();
    }
  };
  const loadAtlas = (key = "CharaCardImages") => {
    const t = new Texture(key);
    t.add("cc034_r01", 0, 2520, 1920, 168, 240);
    t.add("cc034_01", 0, 0, 0, 168, 240);
    textures.set(key, t);
    return t;
  };
  const tick = () => intervals.forEach((fn) => fn());
  const maskImage = (name: string) => new CircleMaskImage(textures, "CharaCardImages", name);
  return { win, sceneList, reports, run, decodeAll, loadAtlas, tick, maskImage };
}

const entry = (frame: string, w = 168, h = 240) => ({
  frame,
  dataUrl: `data:image/png;base64,${w}x${h}`,
});

describe("buildCardArtPatchScript", () => {
  it("圖集還沒載就等，載了之後換上並刷新畫面上的物件（含 Container 裡的）", () => {
    const env = makeEnv();
    const status = parseCardArtStatus(
      env.run(buildCardArtPatchScript({ bindingName: BINDING, entries: [entry("cc034_r01")] })),
    );
    expect(status.installed).toBe(true);
    expect(status.atlasReady).toBe(false);

    const tex = env.loadAtlas();
    const onScreen = new GameImage(tex, "cc034_r01");
    const inContainer = new GameImage(tex, "cc034_r01");
    const other = new GameImage(tex, "cc034_01");
    env.sceneList[0]!.children.list.push(onScreen, { list: [inContainer] }, other);
    const oldFrame = onScreen.frame;

    env.tick();
    env.decodeAll();

    expect(tex.frames["cc034_r01"]).not.toBe(oldFrame);
    expect(tex.frames["cc034_r01"]!.sourceIndex).toBe(1);
    expect(tex.source).toHaveLength(2);
    expect(onScreen.frame).toBe(tex.frames["cc034_r01"]);
    expect(inContainer.frame).toBe(tex.frames["cc034_r01"]);
    expect(other.frame).toBe(tex.frames["cc034_01"]);

    const after = parseCardArtStatus(env.run(CARD_ART_STATUS_EXPRESSION));
    expect(after).toMatchObject({ atlasReady: true, applied: 1, pending: 0, failed: [] });
    expect(env.reports.filter(isCardArtReport)).toEqual([
      { type: "card-art", applied: 1, failed: [] },
    ]);
  });

  it("等比例放大的收、比例不對與圖集沒有的格子回報失敗", () => {
    const env = makeEnv();
    const tex = env.loadAtlas();
    env.run(
      buildCardArtPatchScript({
        bindingName: BINDING,
        entries: [entry("cc034_r01", 336, 480), entry("cc034_01", 200, 200), entry("cc999_r01")],
      }),
    );
    env.decodeAll();
    const st = parseCardArtStatus(env.run(CARD_ART_STATUS_EXPRESSION));
    expect(st.applied).toBe(1);
    expect(st.failed.map((f) => f.frame).sort()).toEqual(["cc034_01", "cc999_r01"]);
    expect(st.failed.find((f) => f.frame === "cc034_01")?.reason).toMatch(/比例/);
    expect(tex.frames["cc034_01"]!.sourceIndex).toBe(0);
  });

  it("重裝先還原再換；拆掉放回原本的 Frame、銷毀多加的 source", () => {
    const env = makeEnv();
    const tex = env.loadAtlas();
    const original = tex.frames["cc034_r01"];
    const img = new GameImage(tex, "cc034_r01");
    env.sceneList[1]!.children.list.push(img);

    env.run(buildCardArtPatchScript({ bindingName: BINDING, entries: [entry("cc034_r01")] }));
    env.decodeAll();
    const firstSource = tex.source[1]!;

    env.run(buildCardArtPatchScript({ bindingName: BINDING, entries: [entry("cc034_r01")] }));
    expect(firstSource.destroyed).toBe(true);
    expect(tex.frames["cc034_r01"]).toBe(original);
    env.decodeAll();
    expect(tex.source).toHaveLength(2);
    expect(tex.frames["cc034_r01"]).not.toBe(original);

    expect(env.run(CARD_ART_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(tex.frames["cc034_r01"]).toBe(original);
    expect(tex.source).toHaveLength(1);
    expect(img.frame).toBe(original);
    expect(env.win["__ulrCardArt"]).toBeUndefined();
    expect(env.run(CARD_ART_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("官方卡面（circleMaskImage）換上時照官方遮罩重畫，拆掉時畫回原本的", () => {
    const env = makeEnv();
    const tex = env.loadAtlas();
    const original = tex.frames["cc034_r01"];
    const card = env.maskImage("cc034_r01");
    const other = env.maskImage("cc034_01");
    env.sceneList[0]!.children.list.push({ list: [card, other] });

    env.run(buildCardArtPatchScript({ bindingName: BINDING, entries: [entry("cc034_r01")] }));
    env.decodeAll();

    expect(card.drawn).toBe(tex.frames["cc034_r01"]);
    expect(card.drawn).not.toBe(original);
    expect(card.cfg).toEqual({ maskType: "roundRectangle", radius: 4 });
    expect(other.drawn).toBe(tex.frames["cc034_01"]);

    expect(env.run(CARD_ART_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(card.drawn).toBe(original);
    expect(card.cfg).toEqual({ maskType: "roundRectangle", radius: 4 });
  });

  it("⚠ 改版前的 cc_front 不理 —— 只有它在的話一直等", () => {
    const env = makeEnv();
    const legacy = env.loadAtlas("cc_front");
    const before = legacy.frames["cc034_r01"];
    env.run(buildCardArtPatchScript({ bindingName: BINDING, entries: [entry("cc034_r01")] }));
    env.tick();
    env.decodeAll();
    expect(legacy.frames["cc034_r01"]).toBe(before);
    expect(parseCardArtStatus(env.run(CARD_ART_STATUS_EXPRESSION)).atlasReady).toBe(false);
  });

  it("清單是空的就只裝旗標、不輪詢", () => {
    const env = makeEnv();
    const st = parseCardArtStatus(
      env.run(buildCardArtPatchScript({ bindingName: BINDING, entries: [] })),
    );
    expect(st).toMatchObject({ installed: true, total: 0 });
  });
});
