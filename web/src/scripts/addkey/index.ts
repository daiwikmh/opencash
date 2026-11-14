import { accountIdPattern } from "shared";
import { errorText, query, say } from "../lib/dom";
import { passkeyOnAccount } from "../lib/near";
import { connectWallet, walletAddPasskey } from "../lib/wallet";

const params = new URLSearchParams(location.search);
const account = (params.get("account") ?? "").trim().toLowerCase();
const key = (params.get("key") ?? "").trim();
const message = query("[data-addkey-message]");
const state = query("[data-addkey-state]");
const go = query<HTMLButtonElement>("[data-addkey-go]");

function done() {
  state.textContent = "Added";
  go.hidden = true;
  say(message, "Done. Go back to the opencash app; it continues on its own.");
}

if (!accountIdPattern.test(account) || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(key)) {
  go.hidden = true;
  say(message, "This link is incomplete. Start again from the opencash app.", "error");
} else {
  query("[data-addkey-account]").textContent = account;
  query("[data-addkey-key]").textContent = key;
  if (await passkeyOnAccount(account, key)) done();
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      say(message, "Connect the wallet that controls this account…");
      await connectWallet();
      say(message, "Approve adding the key in your wallet…");
      await walletAddPasskey(account, key);
      done();
    } catch (error) {
      say(message, errorText(error), "error");
      go.disabled = false;
    }
  });
}
