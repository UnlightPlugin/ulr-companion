/**
 * 「開著它去玩」的那個東西（WP-15）
 * ===================================
 * CDP 連線、頁面攔截、仲裁規則、側通道 —— 四個零件接起來，而且**永遠不會
 * 因為任何一個掛掉而結束**。命令列與托盤跑的是同一份，差別只有誰在畫 UI。
 *
 * ```
 *   遊戲分頁 ──CDP──▶ CdpAdapter ──▶ ArbiterRunner ──▶ arbitration.step()
 *                                        │  ▲
 *                              announce  │  │  both-ready / force-end
 *                                        ▼  │
 *                                     LinkNode ──▶ 中間人 ──▶ 對手的插件
 * ```
 *
 * ⚠ **為什麼要獨立成一個 package，而不是讓托盤直接抄 CLI 那段：**
 * 這裡面有六個「錯了就整個功能安靜失效」的生命週期細節（重連、換場、換階段、
 * 側通道比 CDP 活得久、runner 每次重連換一個、拆 patch）。抄一份的話兩邊會
 * 各自漂移，而漂移的症狀全部是「在某個時機下什麼都沒發生」——
 * 這個專案已經在 `patch-ok` 與 `ws-events` 上各栽過一次。
 *
 * 五種時機都要成立（WP-12 交接文件列的，加上側通道那條）：
 *
 * | 時機             | 靠什麼                                       |
 * | ---------------- | -------------------------------------------- |
 * | 遊戲還沒開       | 連不上就等，無限重試                         |
 * | 開了還在大廳     | 裝得上去（waiting），頁面自己補掛            |
 * | 對戰中途接手     | `Runtime.evaluate` 注入，不需要 reload        |
 * | 打完重新開房     | 頁面偵測 socket 換了 → 重掛；房號跟著換       |
 * | **關掉遊戲再開** | 整條 CDP 死掉 → 重連、重裝、重開 runner       |
 * | **對手還沒開**   | 側通道是 solo → 秒數自動退回滿版 30 秒        |
 */

import type { AgreedSettings, ForceReason, LinkPrefs, LinkStatus } from "@ulr/arbiter-link";
import {
  effectiveCapSeconds,
  LinkNode,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
  normalizePrefs,
  parseLinkTarget,
  roomKey,
  soloSettings,
} from "@ulr/arbiter-link";
import type { CancelPolicy, OkPatchReport, Seat } from "@ulr/cdp-adapter";
import {
  ArbiterRunner,
  createCdpAdapter,
  DEFAULT_DEBUG_PORT,
  DEFAULT_SPEED_LEASE_MS,
  normalizeTint,
} from "@ulr/cdp-adapter";

/** 連不上就每隔這麼久再試一次。玩家不會為了插件而先開遊戲。 */
export const CONNECT_RETRY_MS = 2_000;

/** 硬底線的預設值：剩這麼多秒就一定送出，不再等任何人。 */
export const DEFAULT_DEADLINE_SECONDS = 3;

/**
 * 重裝攔截之間至少隔這麼久。
 *
 * 遊戲重載那幾秒 tick 會連續看到「patch 不見了」（每秒四次）。不節流的話
 * 會在頁面上連跑十幾次安裝腳本，而每一次都會先拆掉前一次裝好的。
 */
export const REINSTALL_COOLDOWN_MS = 3_000;

/**
 * 多久幫加速續一次約。
 *
 * 租約是 10 秒，這裡取三分之一 —— 連掉兩次都還來得及。續約本身極便宜
 * （一次 `Runtime.evaluate`，頁面那端只是寫一個時間戳），跟 `ArbiterRunner`
 * 的 250ms tick 比根本不算什麼。
 */
export const SPEED_RENEW_MS = Math.floor(DEFAULT_SPEED_LEASE_MS / 3);

export interface EngineOptions {
  /** 遊戲的 CDP 埠。桌面版 9333、網頁版看你怎麼開。 */
  port?: number;
  /**
   * 中間人在哪。**兩個插件要指到同一個**，預設值就是為了不用設定。
   *
   * 一個字串，`parseLinkTarget()` 看得懂的都收：`local`、`9350`、
   * `wss://ulr-link.xxx.workers.dev`。舊的 `linkPort`（數字）也還吃得下 ——
   * 純數字就是本機的那個埠。
   */
  link?: string;
  /** 完全不接側通道（單邊模式）。 */
  noLink?: boolean;
  policy?: CancelPolicy;
  deadlineSeconds?: number;
  prefs?: Partial<LinkPrefs>;
  /**
   * 準備中把 OK 鈕染成什麼顏色。`null` = 不染色（官方原本的樣子），預設值。
   *
   * ⚠ **這個不進 `LinkPrefs`。** 它只改我自己畫面上的一個顏色，對手看不到、
   * 也拿不到任何好處 —— 跟秒數與加速不同，沒有協商的必要。純本機偏好放進
   * 協定只會讓兩邊為了一個顏色而版本不合。
   */
  readyTint?: number | null;
  onLog?: (line: string) => void;
  onStatus?: (status: EngineStatus) => void;
}

/** UI 要畫的東西。**每次變動都會整份重發**，畫的人不必自己合併。 */
export interface EngineStatus {
  /** CDP 接上了沒。 */
  connected: boolean;
  /** 遊戲分頁標題（已去識別化）。 */
  title: string | null;
  /** 這一場的座位。每場重新分配。 */
  seat: Seat | null;
  /** 頁面上的攔截真的掛在 socket 上了。還在大廳時是 false。 */
  armed: boolean;
  /** 側通道狀態。 */
  link: LinkStatus;
  /** 我是不是那個中間人。行為上沒差別，只是給玩家看。 */
  hosting: boolean;
  /** 協商後的共同設定。**沒配對到人時秒數會是滿版 30**。 */
  agreed: AgreedSettings;
  /**
   * 對手是**真人**（`duel` / `ranked`）。任務、渦、活動、還沒進對戰都是 `false`。
   *
   * ⚠ 為 `false` 時**準備與約定秒數整組不生效**，而且那是刻意的 ——
   * UI 一定要講出來，否則玩家看到「已接上、已配對」卻沒有任何反應，
   * 只會以為插件壞了。
   */
  pvp: boolean;
  /** 這一場是哪種戰鬥（`duel` / `quest` / `raid` …）。不在對戰中是 `null`。 */
  rule: string | null;
  /** 這個階段有沒有「聖水＋麻痺」。 */
  hazard: boolean;
  /** 目前實際生效的階段秒數（已含 hazard 修正）。null = 不縮短。 */
  capSeconds: number | null;
  /** 最後一次送出 `I_am_ok` 的原因。給玩家看「剛剛發生了什麼」。 */
  lastSend: string | null;
  /**
   * 頁面上**實際生效**的加速倍率。`null` = 沒裝（原速）。
   *
   * ⚠ 跟 `agreed.speedFactor` 分開是必要的：協商完成到頁面真的裝上去之間
   * 有一段 `Runtime.evaluate` 的時間，而且遊戲還在大廳時根本裝不上。
   * UI 只顯示 `agreed` 的話，玩家會看到「已生效」但畫面沒變。
   */
  speedApplied: number | null;
  /** 最後一個錯誤。修好之後會被清成 null。 */
  error: string | null;
}

export class ArbiterEngine {
  #options: EngineOptions;
  #prefs: LinkPrefs;
  /** 準備中的染色。純本機顯示偏好，不進協商 —— 見 EngineOptions.readyTint。 */
  #readyTint: number | null;
  #link: LinkNode | null = null;
  #runner: ArbiterRunner | null = null;
  /** 這一輪連線用的 adapter。加速要在協商變動時重下，所以得留著。 */
  #adapter: ReturnType<typeof createCdpAdapter> | null = null;
  #stopping = false;
  #loop: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;
  #status: EngineStatus;

  constructor(options: EngineOptions = {}) {
    this.#options = options;
    this.#prefs = normalizePrefs(options.prefs);
    this.#readyTint = normalizeTint(options.readyTint ?? null);
    this.#status = {
      connected: false,
      title: null,
      seat: null,
      armed: false,
      // 還沒進對戰 —— 這不是「連不上」，是「還不需要連」。
      link: "idle",
      hosting: false,
      // ⚠ 起始值是**單邊**設定，不是玩家自己選的秒數。沒配對到人就不縮短，
      // 而 UI 從第一幀起就該顯示這個事實。
      agreed: soloSettings(this.#prefs),
      pvp: false,
      rule: null,
      hazard: false,
      capSeconds: null,
      lastSend: null,
      speedApplied: null,
      error: null,
    };
  }

  get status(): EngineStatus {
    return this.#status;
  }

  get prefs(): LinkPrefs {
    return this.#prefs;
  }

  get readyTint(): number | null {
    return this.#readyTint;
  }

  /**
   * 換準備中的染色。**不重裝 patch** —— 重裝會把正壓著的 `I_am_ok` 送出去，
   * 為了改一個顏色讓玩家這回合的 OK 定案完全不值得。
   */
  setReadyTint(tint: number | null): void {
    this.#readyTint = normalizeTint(tint);
    void this.#adapter?.setReadyTint(this.#readyTint).catch(() => {
      // 還沒接上或正在重連。下次 installOkPatch 會帶著新值上去。
    });
  }

  /**
   * 玩家在托盤裡改了設定。
   *
   * 立刻生效，不必重開 —— `capSecondsFor` 每個 tick 重新問，
   * `setHold` 直接下給頁面。
   */
  setPrefs(next: Partial<LinkPrefs>): void {
    this.#prefs = normalizePrefs({ ...this.#prefs, ...next });
    if (this.#link !== null) {
      // 協商結果會從 onChange 回來，加速也在那裡才同步 —— 這裡先動的話
      // 會用到還沒協商過的值，等於單方面加速。
      this.#link.client.setPrefs(this.#prefs);
    } else {
      // ⚠ `--no-link` 就是「永遠不會握手」。setHold 一定要走 agreed 而不是
      // prefs —— 直接讀玩家的偏好會讓單邊模式下準備照樣攔，正是 2026-08-09
      // 要修掉的行為（見 `soloSettings`）。
      const agreed = soloSettings(this.#prefs);
      this.#emit({ agreed });
      void this.#runner?.setHold(agreed.readyEnabled);
      void this.#syncSpeed();
    }
  }

  /** 開始。**不會 throw** —— 連不上只是狀態，不是錯誤。 */
  async start(): Promise<void> {
    if (this.#loop !== null) return;
    this.#stopping = false;

    if (this.#options.noLink !== true) {
      this.#link = await LinkNode.start({
        target: parseLinkTarget(this.#options.link),
        // ⚠ **不是 LOBBY_ROOM_KEY。** `null` = 還沒進對戰 → 根本不連線。
        // 大廳那個房號在本機無害，接上公網之後會變成「所有沒在對戰的人擠進
        // 同一間房」，而且其中兩個會被真的配成一對。見 link-worker 的
        // `parseRoomPath()`。
        room: null,
        prefs: this.#prefs,
        onLog: (line) => this.#log(line),
        onChange: ({ status, agreed }) => {
          this.#emit({ link: status, agreed, hosting: this.#link?.hosting === true });
          // 準備功能要兩邊都同意 —— 對手關掉時我方也要停止攔截。
          void this.#runner?.setHold(agreed.readyEnabled);
          // 加速同理：對手離線或改成 1x，共同值就是 1，這裡要把它拆掉。
          void this.#syncSpeed();
        },
        // ⚠ 唯一從外面進來的就緒訊號，而且是合成的（協定紅線 1）。
        onBothReady: () => this.#runner?.peerBothReady(),
        onForceEnd: () => this.#runner?.peerForceEnd(),
      });
      this.#emit({ hosting: this.#link.hosting });
    }

    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopSpeedLease();
    this.#resolveStop?.();
    await this.#loop;
    this.#loop = null;
    await this.#link?.close();
    this.#link = null;
  }

  #log(line: string): void {
    this.#options.onLog?.(line);
  }

  #emit(patch: Partial<EngineStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#options.onStatus?.(this.#status);
  }

  /** 目前該用的階段秒數。`null` = 不強制提早結束。 */
  #capFor(hazard: boolean): number | null {
    // ⚠ 對 NPC 一律不縮短。`ArbiterRunner` 在非對戰時本來就不會走到這裡，
    // 但這個函式也被 `onStep` 拿去算要顯示的秒數 —— 兩條路要給同一個答案，
    // 否則 UI 會顯示一個根本不會被執行的門檻。
    if (!this.#status.pvp) return null;
    const cap = effectiveCapSeconds(this.#status.agreed, hazard);
    return cap >= MOVE_PHASE_TOTAL_SECONDS ? null : cap;
  }

  /**
   * 把頁面上的加速調成協商出來的倍率。
   *
   * ⚠ **來源一定是 `agreed.speedFactor`，不是 `prefs.speedFactor`。**
   * 玩家自己勾的那個只是他的出價；生效的是雙方的 min。用錯來源的症狀不是
   * 報錯，是「對手明明沒開，我這邊卻在加速」—— 也就是這條協商要防的事。
   *
   * 失敗不算錯誤：還在大廳、剛斷線、遊戲正在重載都會拿不到頁面，而下一次
   * 協商變動或重新接上時會再跑一次。
   */
  async #syncSpeed(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;
    const want = this.#status.agreed.speedFactor;
    try {
      if (want <= MIN_SPEED_FACTOR) {
        this.#stopSpeedLease();
        const gone = await adapter.uninstallSpeedPatch();
        if (gone === "uninstalled") this.#log("→ 加速已關閉（回到原速）");
        this.#emit({ speedApplied: null });
        return;
      }
      const state = await adapter.installSpeedPatch({ factor: want });
      // `waiting` = 腳本裝好了但遊戲場景還沒起來，它自己會補上。
      this.#emit({ speedApplied: state === "ok" ? want : null });
      if (state === "ok") this.#log(`→ 加速 ${want}× 已生效（雙方共同值）`);
      this.#startSpeedLease();
    } catch {
      // 連線正在死或頁面正在重載。重連那條路會再叫一次，這裡安靜退場。
      this.#emit({ speedApplied: null });
    }
  }

  /** 續約的計時器。只在加速真的開著時跑。 */
  #speedLease: ReturnType<typeof setInterval> | null = null;

  #startSpeedLease(): void {
    if (this.#speedLease !== null) return;
    this.#speedLease = setInterval(() => void this.#renewSpeed(), SPEED_RENEW_MS);
    // ⚠ Node 端的計時器不該讓程式活著。少了這行，命令列版本會在使用者
    // Ctrl-C 之後不肯結束。
    this.#speedLease.unref?.();
  }

  #stopSpeedLease(): void {
    if (this.#speedLease === null) return;
    clearInterval(this.#speedLease);
    this.#speedLease = null;
  }

  async #renewSpeed(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null || this.#status.agreed.speedFactor <= MIN_SPEED_FACTOR) {
      this.#stopSpeedLease();
      return;
    }
    try {
      // ⚠ 回 `not-installed` 就要重裝。玩家重載遊戲會把頁面上那份沖掉，
      // 而 `onPatchLost` 只看得到 patch-ok 不見了 —— 遊戲在大廳重載時
      // 那條路根本不會觸發，只有這裡救得回來。
      if ((await adapter.renewSpeedLease()) === "not-installed") await this.#syncSpeed();
    } catch {
      // 連線死了。重連那條路會重裝，這裡不必吵。
    }
  }

  /**
   * 主迴圈。每一輪 = 一次 CDP 連線的生命週期。
   *
   * ⚠ **連線斷掉不算結束**，那是要重連的訊號。只有 `stop()` 會離開這個迴圈。
   */
  async #run(): Promise<void> {
    const stopped = new Promise<void>((resolve) => {
      this.#resolveStop = resolve;
      if (this.#stopping) resolve();
    });

    for (let attach = 1; !this.#stopping; attach++) {
      // ⚠ 每次都用**全新的** adapter。重連是新的 target、新的 execution
      // context，沿用舊實例只會把上一條連線的殘留狀態帶進來。
      const adapter = createCdpAdapter({ port: this.#options.port ?? DEFAULT_DEBUG_PORT });
      this.#adapter = adapter;

      try {
        const title = await this.#connectWhenReady(adapter);
        if (title === null) break;
        this.#emit({ connected: true, title, error: null });
        this.#log(attach === 1 ? `✓ 接上「${title}」` : `✓ 重新接上「${title}」`);

        const lost = new Promise<string>((resolve) => adapter.onDisconnect(resolve));
        adapter.onOkPatchReport((r) => this.#onPageReport(r));

        // ⚠ 不必等到進對戰。沒有 socket 也裝得上（回 waiting），頁面每 200ms
        // 自己補掛 —— 「先開插件再開遊戲」才是玩家實際的順序。
        await adapter.installOkPatch({
          hold: this.#status.agreed.readyEnabled,
          readyTint: this.#readyTint,
        });
        // 重新接上時協商結果可能已經是 3×，頁面卻是全新的 —— 這裡補上。
        await this.#syncSpeed();

        const runner = new ArbiterRunner(adapter.asPageBridge(), {
          config: {
            policy: this.#options.policy ?? "either",
            deadlineSeconds: this.#options.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS,
          },
          capSecondsFor: (hazard) => this.#capFor(hazard),
          onAnnounceReady: (ready) => this.#link?.client.announceReady(ready),
          onAnnounceForceEnd: () => {
            const reason: ForceReason = this.#status.hazard ? "hazard-cap" : "agreed-cap";
            this.#link?.client.announceForceEnd(reason);
          },
          // ⚠ 原始 room id 到這裡為止 —— 送出去的只有雜湊（§12）。
          // `null` = 離開對戰（回大廳，或去打任務／渦）→ 直接退出那間房，
          // 否則會沿用上一場的配對，讓 NPC 戰也拿到 both-ready。
          onRoomChange: (room) => this.#link?.client.setRoom(room === null ? null : roomKey(room)),
          onModeChange: ({ pvp, rule }) => {
            this.#emit({ pvp, rule });
            // 只在**進**了非對戰時講一句。玩家看到「已配對」卻沒反應時，
            // 這一行是唯一告訴他原因的東西。
            if (!pvp && rule !== null) {
              this.#log(`· ${describeRule(rule)}—— 準備與秒數都不生效（只對真人對戰）`);
            }
          },
          /**
           * 遊戲重載把 patch 沖掉了 → 重裝。
           *
           * ⚠ 這條路**不會**觸發重連（CDP 連線還好好的），所以沒有別人會來救。
           * 節流是必要的：tick 每秒四次，不擋的話重載的那幾秒會連發十幾次
           * `Runtime.evaluate`，而每一次都在頁面上重跑一次安裝腳本。
           */
          onPatchLost: () => void this.#reinstall(adapter),
          onError: (err) => this.#emit({ error: err.message }),
          onStep: () => {
            const runnerNow = this.#runner;
            if (runnerNow === null) return;
            this.#emit({
              seat: runnerNow.seat,
              armed: runnerNow.armed,
              hazard: runnerNow.hazard,
              capSeconds: this.#capFor(runnerNow.hazard),
            });
          },
        });
        this.#runner = runner;
        await runner.start();
        this.#emit({ seat: runner.seat, armed: runner.armed });

        const reason = await Promise.race([lost, stopped.then(() => null)]);
        runner.stop();
        this.#runner = null;
        // ⚠ 模式也要清掉。留著「上一次是對戰」會讓重連後的第一段時間 UI 說
        // 功能生效中，而那時根本還沒問過頁面。
        this.#emit({
          connected: false,
          armed: false,
          seat: null,
          speedApplied: null,
          pvp: false,
          rule: null,
        });

        if (reason !== null) {
          // ⚠ 這裡**不要**試著拆攔截 —— 連線已經死了，evaluate 只會再拋一次錯。
          // 頁面那邊心跳 3 秒就過期，攔截自己會停手。
          this.#log(`⟳ 連線斷了（${reason}）—— 遊戲關掉了嗎？重新連…`);
          continue;
        }

        // ⚠ **一定要拆。** 留著的話頁面上會有一個沒有鑰匙的鎖。
        try {
          const gone = await adapter.uninstallOkPatch();
          this.#log(gone === "uninstalled" ? "✓ 攔截已拆除，遊戲回到原本行為" : "（本來就沒裝）");
          // 加速沒有心跳，不拆就會一直留在頁面上直到玩家自己重載遊戲。
          await adapter.uninstallSpeedPatch();
        } catch (err) {
          this.#log(`✗ 拆不掉攔截：${describe(err)}（遊戲重載一次就會乾淨）`);
        }
      } catch (err) {
        this.#runner?.stop();
        this.#runner = null;
        this.#emit({ connected: false, error: describe(err), speedApplied: null });
        if (this.#stopping) break;
        await sleep(CONNECT_RETRY_MS);
      } finally {
        this.#adapter = null;
        await adapter.disconnect();
      }
    }
  }

  /** 同一時間只重裝一次，而且兩次之間至少隔這麼久。 */
  #reinstalling = false;
  #lastReinstall = 0;

  async #reinstall(adapter: ReturnType<typeof createCdpAdapter>): Promise<void> {
    const now = Date.now();
    if (this.#reinstalling || now - this.#lastReinstall < REINSTALL_COOLDOWN_MS) return;
    this.#reinstalling = true;
    this.#lastReinstall = now;
    try {
      const status = await adapter.installOkPatch({
        hold: this.#status.agreed.readyEnabled,
        readyTint: this.#readyTint,
      });
      this.#log(`⟳ 遊戲重載過，攔截已重新裝上（${status}）`);
      this.#emit({ error: null });
      // ⚠ 重載把加速也沖掉了。不補的話症狀是「打到一半突然變回原速」，
      // 而玩家完全不會把它跟「剛剛重載過」連在一起。
      await this.#syncSpeed();
    } catch (err) {
      // 連線多半也快死了 —— 那條路會走重連，這裡安靜退場就好。
      this.#emit({ error: `重裝攔截失敗：${describe(err)}` });
    } finally {
      this.#reinstalling = false;
    }
  }

  #onPageReport(report: OkPatchReport): void {
    if (report.type === "ok-patch-error") {
      this.#emit({ error: report.reason });
      return;
    }
    if (report.type === "ok-patch-rearmed") {
      this.#log(`⟳ 換場，攔截已重新掛上  座位=${report.seat ?? "(還不知道)"}`);
      return;
    }
    if (report.type === "ok-released") {
      // ⚠ `failsafe` 代表連心跳都沒發揮作用 —— 最後一道防線，不該常發生。
      const label: Record<string, string> = {
        arbiter: "仲裁放行",
        forced: "約定秒數到了（替你按的）",
        "phase-ended": "階段結束",
        "node-gone": "⚠ 心跳過期",
        failsafe: "⚠ 失效保護",
        reinstall: "換版",
        uninstall: "拆除",
      };
      const what = label[report.by] ?? report.by;
      this.#emit({ lastSend: what });
      this.#log(`→ 送出 I_am_ok（${what}，壓了 ${(report.heldMs / 1000).toFixed(1)}s）`);
    }
  }

  /**
   * 一直等到連得上為止。回傳分頁標題；被 `stop()` 打斷就回 `null`。
   *
   * ⚠ 沒有次數上限是刻意的：玩家什麼時候開遊戲、開幾次、中途關掉再開，
   * 都不該讓插件自己結束。
   */
  async #connectWhenReady(adapter: ReturnType<typeof createCdpAdapter>): Promise<string | null> {
    for (let attempt = 1; !this.#stopping; attempt++) {
      try {
        const session = await adapter.connect();
        await adapter.waitForGame();
        return session.title;
      } catch (err) {
        // ⚠ 不能安靜地等。埠打錯的症狀會是「跑起來之後什麼都沒發生」，
        // 而真正的原因只在第一行閃過去。
        if (attempt === 1) this.#emit({ connected: false, error: `等遊戲…（${describe(err)}）` });
        await sleep(CONNECT_RETRY_MS);
      }
    }
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * rule 字串 → 玩家看得懂的名字。
 *
 * 認不出來的照原樣印出來，**不要吞掉** —— 遊戲改版多一種模式時，那一行就是
 * 唯一的線索（而症狀會是「這個模式底下插件突然不動了」）。
 */
function describeRule(rule: string): string {
  const names: Record<string, string> = {
    quest: "任務",
    raid: "渦",
    event: "活動",
    duel: "對戰",
    ranked: "排名戰",
  };
  const name = names[rule];
  return name === undefined ? `非對戰模式（${rule}）` : `${name}（對手是 NPC）`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
