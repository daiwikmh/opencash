import assert from "node:assert/strict";
import { KeyPair, Account, type KeyPairString } from "near-api-js";
import { signMessage } from "near-api-js/nep413";
import { accountFor, accountIdPattern, authMessage, authNonce, encodeAuth, handlePattern, nearAuthRecipient, toBase64 } from "shared";

const { hasFullAccessKey, accountExists, provider } = await import("./near.js");
const { verifyNearAuth } = await import("./nearAuth.js");

assert.equal(accountFor("near", "adastudio"), "adastudio.near");
assert.equal(accountFor("opencash", "adastudio"), "adastudio.opencash.near");
for (const ok of ["ada.business.near", "adastudio.near", "a1.near", "x_y.tg", "f".repeat(64)]) assert.ok(accountIdPattern.test(ok), ok);
for (const bad of ["Ada.near", "ada..near", ".ada.near", "ada.near.", "a", "ada near", `${"a".repeat(60)}.near`]) assert.ok(!accountIdPattern.test(bad), bad);
assert.ok(handlePattern.test("adastudio") && !handlePattern.test("ada.studio"), "a handle is one label; dotted names use the existing-account path");

const keys = (await (await fetch("https://rpc.mainnet.near.org", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: "relay.aurora" } }),
  signal: AbortSignal.timeout(15_000),
})).json()) as { result: { keys: { public_key: string; access_key: { permission: unknown } }[] } };
const functionCallKey = keys.result.keys.find((k) => k.access_key.permission !== "FullAccess")!.public_key;
const fullKeys = (await provider.viewAccessKeyList({ accountId: "business.near" })).keys.filter((k) => k.access_key.permission === "FullAccess");
assert.ok(fullKeys.length > 0, "business.near has a full-access key to test against");

assert.equal(await hasFullAccessKey("business.near", fullKeys[0].public_key.toString()), true, "a real full-access key is recognised");
assert.equal(await hasFullAccessKey("relay.aurora", functionCallKey), false, "a function-call key does not count as owning the account");
assert.equal(await hasFullAccessKey("business.near", KeyPair.fromRandom("ed25519").getPublicKey().toString()), false, "a key not on the account is refused");
assert.equal(await hasFullAccessKey("nobody-here-xyz123.near", KeyPair.fromRandom("ed25519").getPublicKey().toString()), false);
assert.equal(await accountExists("business.near"), true);
assert.equal(await accountExists("nobody-here-xyz123.near"), false);

async function authFrom(accountId: string, key: KeyPair, action: string, subject: string) {
  const account = new Account(accountId, provider, key.toString() as KeyPairString);
  const message = authMessage(action, subject);
  const nonce = authNonce();
  const signed = await signMessage({ signerAccount: account, payload: { message, recipient: nearAuthRecipient, nonce } });
  return encodeAuth({ accountId, publicKey: key.getPublicKey().toString(), signature: toBase64(signed.signature), nonce: toBase64(nonce), message });
}
const impostor = KeyPair.fromRandom("ed25519");
await assert.rejects(
  verifyNearAuth(await authFrom("business.near", impostor, "open-company", "business.near"), "open-company", "business.near"),
  /signature rejected/i,
  "someone without a key on business.near cannot register it",
);
await assert.rejects(
  verifyNearAuth(await authFrom("business.near", impostor, "list-payouts", "business"), "open-company", "business.near"),
  /different action/,
  "a signature for another action cannot open a company",
);
await assert.rejects(verifyNearAuth(undefined, "open-company", "business.near"), /Sign in/);

const { createAgent } = await import("./agents.js");
const { db } = await import("./db.js");
const longCompany = "ada-design-studio-international.business.near";
const { agent } = await createAgent(longCompany, { name: "Research bot for market data", per_tx_cap: "1", daily_cap: "2" });
assert.ok(agent.account_id.length <= 64 && agent.account_id.endsWith(`.${longCompany}`) && accountIdPattern.test(agent.account_id), agent.account_id);
const { agent: short } = await createAgent("adastudio.near", { name: "Research bot", per_tx_cap: "1", daily_cap: "2" });
assert.match(short.account_id, /^agent-research-bot-[0-9a-f]{4}\.adastudio\.near$/);
await assert.rejects(createAgent(`${"a".repeat(50)}.business.near`, { name: "x", per_tx_cap: "1", daily_cap: "2" }), /too long/);
await db().query("delete from agents where id = any($1)", [[agent.id, short.id]]);
await db().end();

console.log("signup checks ok");
