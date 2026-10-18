// The settings page. Accounts: list them, play one, copy its bookmark link,
// sign in again, or remove it. Game page: how it looks.

import { FAVICONS, getGameSettings, setGameSettings } from "./game_settings.js";
import {
  bookmarkUrl,
  displayName,
  launchUrl,
  listAccounts,
  onAccountsChanged,
  removeAccount,
} from "./accounts.js";
import { mountLogin } from "./login.js";

const $ = (id) => document.getElementById(id);

function log(message, kind = "info") {
  $("status").textContent = message;
  $("status").dataset.kind = kind;
}

const formatDate = (ms) =>
  new Date(ms).toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

function describe(account) {
  if (!account.signedIn) {
    return "已登出";
  }
  const until = `登入有效到 ${formatDate(account.expires)}`;
  return account.remember ? until : `${until}（只限這次開瀏覽器）`;
}

function button(label, onClick, className = "secondary") {
  const element = document.createElement("button");
  element.textContent = label;
  element.className = className;
  element.addEventListener("click", onClick);
  return element;
}

async function copyLink(account) {
  await navigator.clipboard.writeText(bookmarkUrl(account.steamId));
  log(`已複製 ${displayName(account)} 的書籤連結`);
}

function resetLogin() {
  $("login-title").textContent = "新增帳號";
  $("cancel-relogin").hidden = true;
  mountLogin($("login"), { log, onSignedIn: resetLogin });
}

function relogin(account) {
  $("login-title").textContent = `重新登入 ${displayName(account)}`;
  $("cancel-relogin").hidden = false;
  mountLogin($("login"), {
    steamId: account.steamId,
    accountName: account.accountName,
    log,
    onSignedIn: resetLogin,
  });
  $("login").scrollIntoView({ behavior: "smooth" });
}

function renderAccount(account) {
  const name = document.createElement("strong");
  name.textContent = displayName(account);
  const info = document.createElement("div");
  info.append(name);
  if (account.email) {
    const email = document.createElement("span");
    email.className = "muted";
    email.textContent = ` ${account.email}`;
    info.append(email);
  }
  const meta = document.createElement("div");
  meta.className = "muted small";
  meta.textContent = `${account.steamId} · ${describe(account)}`;
  info.append(meta);

  const remove = button(
    "移除",
    async () => {
      if (!remove.dataset.confirm) {
        remove.dataset.confirm = "true";
        remove.textContent = "再按一次確定移除";
        setTimeout(() => {
          delete remove.dataset.confirm;
          remove.textContent = "移除";
        }, 4000);
        return;
      }
      await removeAccount(account.steamId);
      log(`已移除 ${displayName(account)}`);
    },
    "secondary danger",
  );
  const actions = document.createElement("div");
  actions.className = "actions wrap";
  actions.append(
    button(
      "開始玩",
      () => chrome.tabs.create({ url: launchUrl(account.steamId) }),
      "",
    ),
    button("複製連結", () => copyLink(account)),
    button(account.signedIn ? "重新登入" : "登入", () =>
      relogin(account),
    ),
    remove,
  );

  const item = document.createElement("li");
  item.className = "account";
  item.append(info, actions);
  return item;
}

async function render() {
  const accounts = await listAccounts();
  $("empty").hidden = accounts.length > 0;
  $("accounts").replaceChildren(...accounts.map(renderAccount));
}

async function setUpGameSettings() {
  const form = $("game-settings");
  const { title, favicon, steamCss, autoResize } = await getGameSettings();
  const custom = favicon !== "" && !Object.hasOwn(FAVICONS, favicon);
  form.elements.title.value = title;
  form.elements.favicon.value = custom ? "custom" : favicon;
  form.elements.faviconUrl.value = custom ? favicon : "";
  form.elements.steamCss.checked = steamCss;
  form.elements.autoResize.checked = autoResize;
  $("custom-favicon").hidden = !custom;

  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("change", async () => {
    const choice = form.elements.favicon.value;
    $("custom-favicon").hidden = choice !== "custom";
    const url = form.elements.faviconUrl;
    if (choice === "custom" && (!url.value.trim() || !url.checkValidity())) {
      return;
    }
    await setGameSettings({
      title: form.elements.title.value.trim(),
      favicon: choice === "custom" ? url.value.trim() : choice,
      steamCss: form.elements.steamCss.checked,
      autoResize: form.elements.autoResize.checked,
    });
    log("已儲存遊戲頁設定");
  });
}

$("cancel-relogin").addEventListener("click", resetLogin);
onAccountsChanged(render);
resetLogin();
Promise.all([render(), setUpGameSettings()]).catch((e) => {
  console.error(e);
  log(e.message, "error");
});
