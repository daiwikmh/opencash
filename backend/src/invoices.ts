import { createHash, timingSafeEqual } from "node:crypto";
import { teraToGas } from "near-api-js";
import { toUnits, type Invoice, type InvoiceStatus, type LineItem, type Payment } from "shared";
import { isCompany } from "./business.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { emit } from "./developer.js";
import { operator, view } from "./near.js";

export type InvoiceInput = { client_name: string; due_ms: number; items: LineItem[]; source: Invoice["source"]; reference: string | null };
export type ChainInvoice = {
  id: string;
  company: string;
  amount: string;
  details_hash: string;
  status: InvoiceStatus;
  created_at_ms: number;
  paid_at_ms: number | null;
  settle_tx: string | null;
  payer: string | null;
};
type Row = {
  id: string;
  company: string;
  client_name: string;
  items: LineItem[];
  amount: string;
  due_ms: string;
  source: Invoice["source"];
  reference: string | null;
  details_hash: string;
  status: InvoiceStatus;
  deposit_address: string | null;
  payment: Payment | null;
  settle_tx: string | null;
  paid_at_ms: string | null;
  issued: boolean;
  created_ms: string;
  pay_key: string;
};

const columns =
  "id, company, client_name, items, amount_units::text as amount, due_ms::text, source, reference, details_hash, status, deposit_address, payment, settle_tx, paid_at_ms::text, issued, pay_key, (extract(epoch from created_at) * 1000)::bigint::text as created_ms";
const maxItems = 20;
const maxText = 200;
export const dailyInvoices = 200;
const maxTotalUnits = 10n ** 15n;
const walletSettleMs = 30_000;

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function text(value: unknown, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.length > maxText) fail(400, `${field} must be 1-${maxText} characters.`);
  return trimmed;
}

export function detailsHash(invoice: { id: string; company: string; client_name: string; due_ms: number; items: LineItem[]; source: string; reference: string | null }): string {
  const canonical = JSON.stringify([invoice.id, invoice.company, invoice.client_name, invoice.due_ms, invoice.items.map((i) => [i.description, i.amount]), invoice.source, invoice.reference]);
  return createHash("sha256").update(canonical).digest("hex");
}

function walletPayment(payer: string, amount: string): Payment {
  const usd = (Number(amount) / 1e6).toString();
  return { origin_asset: "USDC", origin_chain: "near", amount_in: usd, amount_in_usd: usd, origin_tx_url: null, refund_reason: null, payer };
}

function toInvoice(row: Row): Invoice {
  return {
    id: row.id,
    company: row.company,
    client_name: row.client_name,
    amount: row.amount,
    due_ms: Number(row.due_ms),
    items: row.items,
    status: row.status,
    created_at_ms: Number(row.created_ms),
    deposit_address: row.deposit_address,
    settle_tx: row.settle_tx,
    paid_at_ms: row.paid_at_ms === null ? null : Number(row.paid_at_ms),
    payment: row.payment,
    source: row.source,
    reference: row.reference,
    pay_key: row.pay_key,
  };
}

function sameInvoice(row: Pick<Row, "company" | "details_hash">, record: ChainInvoice): boolean {
  return record.company === row.company && record.details_hash === row.details_hash;
}

async function reconcile(row: Row, record: ChainInvoice | null, final = false): Promise<Invoice> {
  if (!record || !sameInvoice(row, record)) return toInvoice(row);
  if (!final && record.status === "paid" && record.payer && Date.now() - (record.paid_at_ms ?? 0) < walletSettleMs) {
    return toInvoice({ ...row, status: "pending" });
  }
  const payment = row.payment ?? (record.payer ? walletPayment(record.payer, row.amount) : null);
  const changed =
    record.status !== row.status || (record.settle_tx ?? null) !== row.settle_tx || String(record.paid_at_ms ?? "") !== String(row.paid_at_ms ?? "") || payment !== row.payment || !row.issued;
  if (!changed) return toInvoice(row);
  const { rows } = await db().query<Row>(
    `update invoices set status = $2, settle_tx = $3, paid_at_ms = $4, payment = $5, issued = true, deposit_address = case when $2 = 'open' then null else deposit_address end
     where id = $1 returning ${columns}`,
    [row.id, record.status, record.settle_tx ?? null, record.paid_at_ms ?? null, payment],
  );
  const updated = toInvoice(rows[0]);
  if (row.status !== "paid" && record.status === "paid" && record.payer) await emit(updated.company, "invoice.paid", updated).catch(() => undefined);
  return updated;
}

const call = async <T>(methodName: string, args: Record<string, unknown>) => (await operator().callFunction({ contractId: config.contract, methodName, args, gas: teraToGas(30) })) as T;

export const chain = {
  create: (args: { id: string; company: string; amount: string; details_hash: string }) => call<ChainInvoice>("create_invoice", args),
  attest: (args: { id: string; status: InvoiceStatus; settle_tx: string | null }) => call<ChainInvoice>("attest_invoice", args),
  settle: (args: { id: string; settle_tx: string }) => call<ChainInvoice>("record_settlement", args),
  get: (id: string) => view<ChainInvoice | null>("get_invoice", { id }),
  list: (company: string) => view<ChainInvoice[]>("list_invoices", { account_id: company, from: 0, limit: 100 }),
};

async function chainInvoice(id: string): Promise<ChainInvoice | null> {
  return chain.get(id).catch(() => null);
}

async function issue(row: Pick<Row, "id" | "company" | "amount" | "details_hash">): Promise<void> {
  try {
    await chain.create({ id: row.id, company: row.company, amount: row.amount, details_hash: row.details_hash });
  } catch (error) {
    if (!String(error).includes("already exists")) throw error;
    const existing = await chain.get(row.id);
    if (!existing || !sameInvoice(row, existing)) throw new Error(`A different invoice already uses the ID ${row.id} on NEAR.`);
  }
  await db().query("update invoices set issued = true where id = $1", [row.id]);
}

export async function createInvoice(company: string, input: InvoiceInput): Promise<Invoice> {
  if (!(await isCompany(company))) fail(404, "Only a registered opencash business can invoice.");
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0 || items.length > maxItems) fail(400, `An invoice needs 1-${maxItems} line items.`);
  const clean = items.map((item) => {
    const amount = String(item?.amount ?? "").trim();
    if (!/^\d+(\.\d{1,6})?$/.test(amount)) fail(400, `Line item amount "${amount}" must be a number with up to 6 decimals.`);
    return { description: text(item?.description, "Line item description"), amount };
  });
  const total = clean.reduce((sum, item) => sum + BigInt(toUnits(item.amount)), 0n);
  if (total <= 0n) fail(400, "The invoice total must be above zero.");
  if (total > maxTotalUnits) fail(400, "The invoice total is too large.");
  const clientName = text(input.client_name, "Client name");
  const reference = input.reference === null || input.reference === undefined || input.reference === "" ? null : text(input.reference, "Reference");
  if (!Number.isFinite(input.due_ms) || input.due_ms <= 0) fail(400, "Pick a due date.");
  const client = await db().connect();
  let row: Row;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [company]);
    const { rows: recent } = await client.query<{ n: number }>("select count(*)::int as n from invoices where company = $1 and created_at > now() - interval '1 day'", [company]);
    if (recent[0].n >= dailyInvoices) fail(429, `opencash records up to ${dailyInvoices} invoices per business per day on NEAR. Try again tomorrow.`);
    const { rows: next } = await client.query<{ seq: number }>("select coalesce(max(seq), 0) + 1 as seq from invoices where company = $1", [company]);
    const seq = next[0].seq;
    const id = `${company}-${seq}`;
    const hash = detailsHash({ id, company, client_name: clientName, due_ms: input.due_ms, items: clean, source: input.source, reference });
    const { rows } = await client.query<Row>(
      `insert into invoices (id, company, seq, client_name, items, amount_units, due_ms, source, reference, details_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${columns}`,
      [id, company, seq, clientName, JSON.stringify(clean), total.toString(), input.due_ms, input.source, reference, hash],
    );
    await client.query("commit");
    row = rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  try {
    await issue(row);
  } catch (error) {
    fail(503, `Invoice ${row.id} is saved but couldn't be recorded on NEAR yet (${String(error).slice(0, 120)}). opencash retries automatically.`);
  }
  return toInvoice({ ...row, issued: true });
}

export async function getInvoice(id: string): Promise<Invoice> {
  const { rows } = await db().query<Row>(`select ${columns} from invoices where id = $1`, [id]);
  if (!rows[0]) fail(404, "Invoice not found");
  return reconcile(rows[0], await chainInvoice(id));
}

export async function publicInvoice(id: string, key: unknown): Promise<Invoice> {
  const invoice = await getInvoice(id);
  const given = Buffer.from(String(key ?? ""));
  const expected = Buffer.from(invoice.pay_key ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) fail(404, "Invoice not found");
  return invoice;
}

export async function assertRecorded(id: string): Promise<void> {
  const { rows } = await db().query<Row>(`select ${columns} from invoices where id = $1`, [id]);
  const record = await chainInvoice(id);
  if (!rows[0] || !record || !sameInvoice(rows[0], record)) fail(409, "This invoice is still being recorded on NEAR. Try again in a minute.");
}

export async function settleWalletPayment(id: string, payer: string, txHash: string): Promise<Invoice> {
  const { rows } = await db().query<Row>(`select ${columns} from invoices where id = $1`, [id]);
  if (!rows[0]) fail(404, "Invoice not found");
  let record = await chainInvoice(id);
  if (!record || !sameInvoice(rows[0], record) || record.status !== "paid" || record.payer !== payer) {
    fail(409, "This invoice isn't marked paid by that account on NEAR yet.");
  }
  if (!record.settle_tx) record = await chain.settle({ id, settle_tx: txHash });
  return reconcile(rows[0], record, true);
}

export async function reconcileOpen(log: (message: string) => void) {
  const { rows } = await db().query<{ company: string }>(
    "select distinct company from invoices where issued and status in ('open', 'pending') and created_at > now() - interval '14 days' limit 50",
  );
  for (const { company } of rows) {
    try {
      await listInvoices(company);
    } catch (error) {
      log(`reconcile ${company} skipped: ${String(error).slice(0, 160)}`);
    }
  }
}

export async function findInvoice(id: string): Promise<Invoice | null> {
  try {
    return await getInvoice(id);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
}

export async function listInvoices(company: string): Promise<Invoice[]> {
  const { rows } = await db().query<Row>(`select ${columns} from invoices where company = $1 order by created_at desc limit 100`, [company]);
  if (rows.length === 0) return [];
  const records = await chain.list(company).catch(() => [] as ChainInvoice[]);
  const byId = new Map(records.map((c) => [c.id, c]));
  return Promise.all(rows.map((row) => reconcile(row, byId.get(row.id) ?? null)));
}

export async function pendingInvoiceIds(): Promise<string[]> {
  const { rows } = await db().query<{ id: string }>("select id from invoices where status = 'pending' order by created_at limit 100");
  return rows.map((r) => r.id);
}

export async function attestInvoice(
  id: string,
  status: InvoiceStatus,
  extra: { deposit_address?: string; settle_tx?: string; payment?: Payment } = {},
): Promise<Invoice> {
  const record = await chain.attest({ id, status, settle_tx: extra.settle_tx ?? null });
  const { rows } = await db().query<Row>(
    `update invoices set status = $2, settle_tx = $3, paid_at_ms = $4,
       deposit_address = case when $2 = 'open' then null else coalesce($5, deposit_address) end,
       payment = coalesce($6, payment)
     where id = $1 returning ${columns}`,
    [id, record.status, record.settle_tx ?? null, record.paid_at_ms ?? null, extra.deposit_address ?? null, extra.payment ?? null],
  );
  return toInvoice(rows[0]);
}

export async function issueUnrecorded(log: (message: string) => void) {
  const { rows } = await db().query<Row>(`select ${columns} from invoices where not issued and created_at < now() - interval '10 seconds' order by created_at limit 20`);
  for (const row of rows) {
    try {
      await issue(row);
      log(`invoice ${row.id} recorded on NEAR`);
    } catch (error) {
      log(`invoice ${row.id} still not on NEAR: ${String(error).slice(0, 160)}`);
    }
  }
}
