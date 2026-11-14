import { accountFor, accountIdPattern, handlePattern, type AccountKind } from "shared";
import { api } from "../lib/api";
import { errorText, query, say } from "../lib/dom";
import { passkeyAuth, passkeyOnAccount } from "../lib/near";
import { createPasskey, passkeysSupported, signInWithPasskey, type PasskeySession } from "../lib/passkey";
import { connectWallet, walletAddPasskey } from "../lib/wallet";
import { devCompany, devSession, undeployedCompany } from "./dev";
import { state } from "./state";

const gate = query("[data-gate]");
const startForm = query<HTMLFormElement>("[data-start-form]");
const signinForm = query<HTMLFormElement>("[data-signin-form]");
const status = query("[data-gate-status]");
const signinStatus = query("[data-signin-status]");
const startButton = query<HTMLButtonElement>("[data-start]");
const preview = query("[data-handle-preview]");

function text(name: string): string {
  return (startForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value.trim();
}

export function initGate(onReady: (session: PasskeySession) => Promise<void>) {
  if (!passkeysSupported()) say(status, "This browser has no passkey support. Use Chrome, Safari or Edge.", "error");

  const handleInput = startForm.elements.namedItem("handle") as HTMLInputElement;
  const showPreview = () => {
    const kind = text("kind") as AccountKind;
    const name = text("handle").toLowerCase();
    handleInput.placeholder = kind === "existing" ? "ada.business.near" : "acmestudio";
    preview.textContent =
      kind === "existing"
        ? "Any NEAR account you control. You'll approve adding your passkey in your wallet once."
        : kind === "near"
          ? `${accountFor("near", name || "acmestudio")} · yours, not tied to opencash`
          : `${accountFor("opencash", name || "acmestudio")} · instant, under opencash`;
  };
  startForm.addEventListener("input", showPreview);
  startForm.addEventListener("change", showPreview);

  startForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const kind = text("kind") as AccountKind;
    const name = text("handle").toLowerCase();
    if (!text("business")) return say(status, "Enter your business name.", "error");
    if (kind === "existing" ? !accountIdPattern.test(name) : !handlePattern.test(name)) {
      return say(status, kind === "existing" ? "Enter your NEAR account, e.g. ada.business.near." : "Account name: lowercase letters, numbers and dashes.", "error");
    }
    if (!text("country")) return say(status, "Choose your country.", "error");
    const accountId = kind === "existing" ? name : accountFor(kind, name);
    const inviteCode = text("invite") || undefined;
    startButton.disabled = true;
    try {
      if (kind !== "existing" || inviteCode) {
        const invite = await api.checkInvite(inviteCode ?? "");
        if (!invite.ok) throw new Error(kind === "existing" ? invite.error! : `${invite.error} Without a code, pick "Existing account".`);
      }
      say(status, "Create your passkey…");
      const session = await createPasskey(accountId, text("founder") || text("business"));
      const input = { kind, accountId, legalName: text("business"), country: text("country"), publicKey: session.key.publicKey, inviteCode };
      if (kind === "existing") {
        if (!(await passkeyOnAccount(accountId, session.key.publicKey))) {
          say(status, `Connect the wallet that controls ${accountId}…`);
          await connectWallet();
          say(status, `Approve adding your passkey to ${accountId} in your wallet…`);
          await walletAddPasskey(accountId, session.key.publicKey);
          say(status, "Waiting for NEAR to confirm your key…");
          for (let attempt = 0; !(await passkeyOnAccount(accountId, session.key.publicKey)); attempt++) {
            if (attempt >= 30) throw new Error("NEAR hasn't confirmed the new key yet. Try again in a minute.");
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
        say(status, "Registering your business with opencash…");
        state.company = (await api.createCompany(input, await passkeyAuth(session, "open-company", accountId))).company;
      } else {
        say(status, `Opening ${accountId} on NEAR…`);
        state.company = (await api.createCompany(input)).company;
      }
      await onReady(session);
    } catch (error) {
      say(status, errorText(error), "error");
      startButton.disabled = false;
    }
  });

  document.querySelector("[data-dev-login]")?.addEventListener("click", async () => {
    const session = devSession();
    try {
      say(status, `Dev mode: opening ${session.accountId} on NEAR…`);
      try {
        state.company = await devCompany(session);
      } catch (error) {
        if (!/does not exist|Missing env/.test(errorText(error))) throw error;
        state.company = undeployedCompany(session);
        state.preview = errorText(error);
      }
      await onReady(session);
    } catch (error) {
      say(status, `Dev mode: ${errorText(error)}`, "error");
    }
  });

  signinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      say(signinStatus, "Waiting for your passkey…");
      await onReady(await signInWithPasskey());
    } catch (error) {
      say(signinStatus, errorText(error), "error");
    }
  });

  query("[data-show-signin]").addEventListener("click", () => {
    startForm.hidden = true;
    signinForm.hidden = false;
  });
  query("[data-show-start]").addEventListener("click", () => {
    signinForm.hidden = true;
    startForm.hidden = false;
  });
}

export function hideGate() {
  gate.hidden = true;
  query("[data-dash]").hidden = false;
}
