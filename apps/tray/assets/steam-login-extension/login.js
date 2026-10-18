// The Steam sign-in form, shared by the settings page and the launcher.

import { getAccountInfo, logInWithPassword } from "./steam_cm.js";
import { getMachineSeed, saveAccount, tokenInfo } from "./accounts.js";

const TEMPLATE = `
  <form class="password-form">
    <label>
      Steam 帳號名稱（不是 Email）
      <input name="account" autocomplete="username" required />
    </label>
    <label>
      密碼
      <input name="password" type="password" autocomplete="current-password" required />
    </label>
    <button>登入</button>
  </form>
  <form class="guard-form" hidden>
    <label>
      <span class="guard-label">Steam Guard 驗證碼</span>
      <input name="code" autocomplete="one-time-code" required />
    </label>
    <button>送出</button>
  </form>
  <label class="check">
    <input type="checkbox" name="remember" checked />
    在這台電腦記住登入
  </label>
`;

/**
 * Render a sign-in form into `root`. Every account signed in to is saved, and
 * onSignedIn(steamId) runs once it is. With `steamId`, it runs only for that
 * account, so a bookmark never ends up playing as someone else.
 */
export function mountLogin(
  root,
  { steamId = null, accountName = "", log, onSignedIn },
) {
  root.innerHTML = TEMPLATE;
  const passwordForm = root.querySelector(".password-form");
  const guardForm = root.querySelector(".guard-form");
  const remember = root.querySelector('[name="remember"]');
  passwordForm.elements.account.value = accountName;

  function setBusy(busy, elements = root.querySelectorAll("input, button")) {
    for (const element of elements) {
      element.disabled = busy;
    }
  }

  function showGuard(show) {
    guardForm.hidden = !show;
    passwordForm.hidden = show;
    remember.parentElement.hidden = show;
  }

  function askCode(kind, retry) {
    root.querySelector(".guard-label").textContent =
      kind === "email"
        ? "Email 收到的 Steam Guard 驗證碼"
        : "Steam 手機 App 上的 Steam Guard 驗證碼";
    log(
      retry
        ? "Steam Guard 驗證碼錯了，再輸入一次"
        : "Steam 要 Steam Guard 驗證碼",
      retry ? "error" : "info",
    );
    guardForm.reset();
    showGuard(true);
    setBusy(false, guardForm.elements);
    guardForm.elements.code.focus();
    return new Promise((resolve) => {
      guardForm.onsubmit = (event) => {
        event.preventDefault();
        guardForm.onsubmit = null;
        setBusy(true, guardForm.elements);
        log("檢查驗證碼中");
        resolve(guardForm.elements.code.value.trim());
      };
    });
  }

  async function save(refreshToken, name) {
    const info = tokenInfo(refreshToken);
    log("確認帳號中");
    const { email } = await getAccountInfo(refreshToken, {
      machineSeed: await getMachineSeed(),
    });
    await saveAccount(refreshToken, {
      accountName: name,
      email,
      remember: remember.checked,
    });
    if (steamId && info.steamId !== steamId) {
      log(
        `已把 ${name}（${info.steamId}）存進帳號清單，但這裡要的是 Steam 帳號 ${steamId}。請改用那個帳號登入。`,
        "error",
      );
      passwordForm.elements.account.value = accountName;
      return null;
    }
    log(`已登入 ${name}`);
    return info.steamId;
  }

  async function run(task) {
    setBusy(true);
    let signedIn = null;
    try {
      signedIn = await task();
    } catch (e) {
      console.error(e);
      log(e.message, "error");
    } finally {
      showGuard(false);
      setBusy(false);
    }
    if (signedIn) {
      passwordForm.reset();
      passwordForm.elements.account.value = accountName;
      await onSignedIn(signedIn);
    }
  }

  passwordForm.onsubmit = (event) => {
    event.preventDefault();
    const name = passwordForm.elements.account.value.trim();
    const password = passwordForm.elements.password.value;
    // Only Steam ever sees the password, RSA-encrypted; it is not kept anywhere.
    passwordForm.elements.password.value = "";
    run(async () => {
      log("登入 Steam 中");
      const refreshToken = await logInWithPassword(name, password, {
        machineSeed: await getMachineSeed(),
        askCode,
        log,
      });
      return save(refreshToken, name);
    });
  };
}
