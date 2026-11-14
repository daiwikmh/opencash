import assert from "node:assert/strict";
import type { InvoiceStatus } from "shared";
import type { ChainInvoice } from "./invoices.js";

const { db } = await import("./db.js");
const { registerCompany, isCompany } = await import("./business.js");
const { chain, createInvoice, getInvoice, listInvoices, attestInvoice, pendingInvoiceIds, issueUnrecorded, detailsHash, publicInvoice, assertRecorded, settleWalletPayment, reconcileOpen } = await import("./invoices.js");
const { registeredCompany } = await import("./relayer.js");

const ledger = new Map<string, ChainInvoice>();
const realCreate = chain.create;
chain.create = async ({ id, company, amount, details_hash }) => {
  if (ledger.has(id)) throw new Error("invoice id already exists");
  if (!id.startsWith(`${company}-`)) throw new Error("invoice id must start with the company account");
  const record: ChainInvoice = { id, company, amount, details_hash, status: "open", created_at_ms: Date.now(), paid_at_ms: null, settle_tx: null, payer: null };
  ledger.set(id, record);
  return record;
};
chain.attest = async ({ id, status, settle_tx }) => {
  const record = ledger.get(id);
  if (!record) throw new Error("unknown invoice");
  if (record.status === "paid") throw new Error("invoice already paid");
  record.status = status;
  if (settle_tx) record.settle_tx = settle_tx;
  if (status === "paid") record.paid_at_ms = Date.now();
  return { ...record };
};
chain.settle = async ({ id, settle_tx }) => {
  const record = ledger.get(id)!;
  if (record.settle_tx) throw new Error("settlement already recorded");
  record.settle_tx = settle_tx;
  return { ...record };
};
chain.get = async (id) => (ledger.has(id) ? { ...ledger.get(id)! } : null);
chain.list = async (company) => [...ledger.values()].filter((r) => r.company === company).map((r) => ({ ...r }));
assert.notEqual(realCreate, chain.create);

const run = Date.now() % 1_000_000;
const ada = `ada${run}.near`;
const adaBiz = `ada${run}.business.near`;
const stranger = `stranger${run}.near`;
await registerCompany(ada, "Ada Studio", "Nigeria");
await registerCompany(adaBiz, "Ada Business", "Nigeria");
assert.ok(await isCompany(ada) && !(await isCompany(stranger)));
assert.equal(await registeredCompany(adaBiz), true, "the relayer reads the business list from Postgres");
assert.equal(await registeredCompany(stranger), false);

const due = Date.UTC(2026, 11, 1);
const first = await createInvoice(ada, { client_name: "Northwind", due_ms: due, items: [{ description: "Design sprint", amount: "1250.50" }, { description: "Hosting", amount: "49" }], source: "direct", reference: null });
assert.equal(first.id, `${ada}-1`);
assert.equal(first.amount, "1299500000", "the total is computed from the line items");
const onChain = ledger.get(first.id)!;
assert.deepEqual(Object.keys(onChain).sort(), ["amount", "company", "created_at_ms", "details_hash", "id", "paid_at_ms", "payer", "settle_tx", "status"], "only the slim record goes on chain");
assert.ok(!JSON.stringify(onChain).includes("Northwind") && !JSON.stringify(onChain).includes("Design sprint"), "client name and line items stay off chain");
assert.equal(onChain.details_hash, detailsHash({ id: first.id, company: ada, client_name: "Northwind", due_ms: due, items: first.items, source: "direct", reference: null }), "anyone holding the invoice can check it against the on-chain hash");
assert.equal(onChain.amount, first.amount);

const biz = await createInvoice(adaBiz, { client_name: "Globex", due_ms: due, items: [{ description: "Audit", amount: "20" }], source: "api", reference: "order_1" });
assert.equal(biz.id, `${adaBiz}-1`, "same first name, separate invoice numbers");
assert.equal((await getInvoice(first.id)).client_name, "Northwind", "the first business's invoice is untouched");

const many = await Promise.all([1, 2, 3, 4, 5].map((n) => createInvoice(ada, { client_name: `C${n}`, due_ms: due, items: [{ description: "x", amount: "1" }], source: "link", reference: null })));
assert.deepEqual(new Set(many.map((i) => i.id)).size, 5, "concurrent invoices get distinct ids");
assert.deepEqual(many.map((i) => Number(i.id.split("-").pop())).sort((a, b) => a - b), [2, 3, 4, 5, 6]);

await assert.rejects(createInvoice(stranger, { client_name: "X", due_ms: due, items: [{ description: "x", amount: "1" }], source: "direct", reference: null }), /registered opencash business/);
await assert.rejects(createInvoice(ada, { client_name: "X", due_ms: due, items: [], source: "direct", reference: null }), /1-20 line items/);
await assert.rejects(createInvoice(ada, { client_name: "X", due_ms: due, items: [{ description: "x", amount: "1.1234567" }], source: "direct", reference: null }), /up to 6 decimals/);
await assert.rejects(createInvoice(ada, { client_name: "X", due_ms: due, items: [{ description: "x", amount: "0" }], source: "direct", reference: null }), /above zero/);
await assert.rejects(createInvoice(ada, { client_name: " ", due_ms: due, items: [{ description: "x", amount: "1" }], source: "direct", reference: null }), /Client name/);

const pending = await attestInvoice(first.id, "pending", { deposit_address: "0xdeposit" });
assert.equal(pending.status, "pending");
assert.equal(pending.deposit_address, "0xdeposit");
assert.ok((await pendingInvoiceIds()).includes(first.id), "the watcher finds pending invoices in Postgres");
const payment = { origin_asset: "ETH", origin_chain: "arb", amount_in: "0.4", amount_in_usd: "1301.2", origin_tx_url: "https://arbiscan.io/tx/0xabc", refund_reason: null };
const paid = await attestInvoice(first.id, "paid", { settle_tx: "SettleHash", payment });
assert.equal(paid.status, "paid");
assert.equal(paid.settle_tx, "SettleHash");
assert.deepEqual(paid.payment, payment);
assert.ok(paid.paid_at_ms);
assert.ok(!(await pendingInvoiceIds()).includes(first.id));
await assert.rejects(attestInvoice(first.id, "refunded"), /already paid/, "paid stays final");
assert.equal((await getInvoice(first.id)).status, "paid");

assert.ok(first.pay_key && first.pay_key.length === 32, "every invoice gets a random pay key");
assert.equal((await publicInvoice(first.id, first.pay_key)).client_name, "Northwind", "the pay link's key opens the invoice");
for (const wrong of [undefined, "", "0".repeat(32), first.pay_key.slice(1)]) {
  await assert.rejects(publicInvoice(first.id, wrong), /not found/, "without the key, the public route reveals nothing, even though IDs are guessable");
}

const wallet = many[0];
const record = ledger.get(wallet.id)!;
record.status = "paid";
record.paid_at_ms = Date.now();
record.payer = "payer.near";
assert.equal((await getInvoice(wallet.id)).status, "pending", "a fresh wallet payment isn't trusted while the forward could still fail");
assert.equal((await db().query("select status from invoices where id = $1", [wallet.id])).rows[0].status, "open", "and nothing is written yet");
record.status = "open";
record.paid_at_ms = null;
record.payer = null;
assert.equal((await getInvoice(wallet.id)).status, "open", "a forward that failed leaves the invoice open, with no false paid webhook");
await assert.rejects(settleWalletPayment(wallet.id, "payer.near", "WalletTx"), /isn't marked paid/);
record.status = "paid";
record.paid_at_ms = Date.now() - 60_000;
record.payer = "payer.near";
const reconciled = await getInvoice(wallet.id);
assert.equal(reconciled.status, "paid", "a NEAR-wallet payment recorded only on chain shows up as paid");
assert.equal(reconciled.payment?.payer, "payer.near");
assert.equal(reconciled.payment?.origin_chain, "near");
const { rows: stored } = await db().query("select status, payment from invoices where id = $1", [wallet.id]);
assert.equal(stored[0].status, "paid", "and Postgres is updated to match");
assert.equal((await settleWalletPayment(wallet.id, "payer.near", "WalletTx")).settle_tx, "WalletTx");

const fresh = many[1];
const freshRecord = ledger.get(fresh.id)!;
Object.assign(freshRecord, { status: "paid", paid_at_ms: Date.now(), payer: "fast.near" });
await assert.rejects(settleWalletPayment(fresh.id, "someone-else.near", "Tx2"), /isn't marked paid by that account/);
const settledNow = await settleWalletPayment(fresh.id, "fast.near", "Tx2");
assert.equal(settledNow.status, "paid", "once the payer's transaction is verified final, the payment is recorded immediately");
assert.equal(settledNow.settle_tx, "Tx2");

const quiet = many[2];
Object.assign(ledger.get(quiet.id)!, { status: "paid", paid_at_ms: Date.now() - 60_000, payer: "quiet.near" });
await reconcileOpen(() => undefined);
assert.equal((await db().query("select status from invoices where id = $1", [quiet.id])).rows[0].status, "paid", "the watcher notices wallet payments nobody opened the page for");

const foreign = many[3];
ledger.set(foreign.id, { ...ledger.get(foreign.id)!, details_hash: "b".repeat(64), amount: "999000000" });
assert.equal((await getInvoice(foreign.id)).amount, foreign.amount, "an on-chain record with a different fingerprint is ignored");
await assert.rejects(assertRecorded(foreign.id), /still being recorded/, "and can't be paid through a quote");
await assert.rejects(createInvoice(ada, { client_name: "Huge", due_ms: due, items: [{ description: "x", amount: "1000000001" }], source: "direct", reference: null }), /too large/);

chain.create = async () => {
  throw new Error("RPC unavailable");
};
await assert.rejects(createInvoice(adaBiz, { client_name: "Initech", due_ms: due, items: [{ description: "y", amount: "5" }], source: "chat", reference: null }), /saved but couldn't be recorded on NEAR/);
const { rows: waiting } = await db().query<{ id: string; issued: boolean }>("select id, issued from invoices where company = $1 and client_name = 'Initech'", [adaBiz]);
assert.equal(waiting[0].issued, false, "the invoice is kept and marked as not yet on chain");
const clash = `${adaBiz}-3`;
ledger.set(clash, { id: clash, company: adaBiz, amount: "1", details_hash: "c".repeat(64), status: "open", created_at_ms: 0, paid_at_ms: null, settle_tx: null, payer: null });
chain.create = async ({ id, company, amount, details_hash }) => {
  if (ledger.has(id)) throw new Error("invoice id already exists");
  const r: ChainInvoice = { id, company, amount, details_hash, status: "open", created_at_ms: Date.now(), paid_at_ms: null, settle_tx: null, payer: null };
  ledger.set(id, r);
  return r;
};
await db().query("update invoices set created_at = now() - interval '1 minute' where id = $1", [waiting[0].id]);
const logs: string[] = [];
await issueUnrecorded((m) => logs.push(m));
assert.ok(ledger.has(waiting[0].id), "the watcher records it on chain later");
assert.equal((await db().query("select issued from invoices where id = $1", [waiting[0].id])).rows[0].issued, true);
await assert.rejects(
  createInvoice(adaBiz, { client_name: "Clash", due_ms: due, items: [{ description: "z", amount: "7" }], source: "api", reference: null }),
  /different invoice already uses the ID/,
  "an ID already taken on NEAR by a different invoice is never silently reused",
);
assert.equal((await db().query("select issued from invoices where id = $1", [clash])).rows[0].issued, false);

const { dailyInvoices } = await import("./invoices.js");
await db().query(
  "insert into invoices (id, company, seq, client_name, items, amount_units, due_ms, source, details_hash, issued) select $1 || '-' || g, $1, g, 'Bulk', '[]', 1, 1, 'api', repeat('a', 64), true from generate_series(1000, 999 + $2) g",
  [adaBiz, dailyInvoices],
);
await assert.rejects(createInvoice(adaBiz, { client_name: "One more", due_ms: due, items: [{ description: "x", amount: "1" }], source: "api", reference: null }), /per business per day/, "a business can't drain the registry's storage");

const listed = await listInvoices(ada);
assert.equal(listed.length, 6);
assert.equal(listed.find((i) => i.id === first.id)?.client_name, "Northwind", "the dashboard list merges Postgres details with on-chain status");
assert.equal(listed.find((i) => i.id === wallet.id)?.status, "paid");

const statuses: InvoiceStatus[] = listed.map((i) => i.status);
assert.ok(statuses.includes("paid") && statuses.includes("open"));

await db().query("delete from invoices where company = any($1)", [[ada, adaBiz]]);
await db().query("delete from companies where account_id = any($1)", [[ada, adaBiz]]);
await db().end();
console.log("hybrid invoice checks ok");
