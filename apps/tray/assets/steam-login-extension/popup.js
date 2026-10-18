// The toolbar popup: pick an account to play, or go to the settings page.

import { displayName, launchUrl, listAccounts } from "./accounts.js";

const $ = (id) => document.getElementById(id);

async function main() {
  const accounts = await listAccounts();
  $("empty").hidden = accounts.length > 0;
  $("manage").textContent = accounts.length
    ? "管理帳號"
    : "新增帳號";
  $("manage").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $("accounts").replaceChildren(
    ...accounts.map((account) => {
      const name = document.createElement("span");
      name.textContent = displayName(account);
      const state = document.createElement("span");
      state.className = "muted small";
      state.textContent = account.signedIn ? "開始玩" : "要登入";
      const play = document.createElement("button");
      play.className = "secondary";
      play.append(name, state);
      play.addEventListener("click", async () => {
        await chrome.tabs.create({ url: launchUrl(account.steamId) });
        window.close();
      });
      const item = document.createElement("li");
      item.append(play);
      return item;
    }),
  );
}

main().catch((e) => console.error(e));
