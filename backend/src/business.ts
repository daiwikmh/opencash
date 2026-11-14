import type { AccountType, Company, CompanyStatus, Jurisdiction } from "shared";
import { config } from "./config.js";
import { db } from "./db.js";

type ChainCompany = Pick<Company, "account_id" | "account_type" | "owner" | "legal_name" | "country" | "created_at_ms" | "updated_at_ms">;

export function inviteRequired(): boolean {
  return config.inviteCodes.size > 0;
}

export async function inviteError(code: string | undefined): Promise<string | null> {
  if (!inviteRequired()) return null;
  const key = (code ?? "").trim().toUpperCase();
  const limit = config.inviteCodes.get(key);
  if (!limit) return "That invite code isn't valid. opencash is invite-only during judging.";
  const { rows } = await db().query<{ used: number }>("select count(*)::int as used from companies where invite_code = $1", [key]);
  return rows[0].used >= limit ? "That invite code has been used up." : null;
}

export async function registerCompany(account: string, legalName: string, country: string, inviteCode?: string, accountType: AccountType = "business"): Promise<ChainCompany> {
  await db().query(
    "insert into companies (account_id, legal_name, country, invite_code, account_type) values ($1, $2, $3, $4, $5) on conflict (account_id) do nothing",
    [account, legalName, country, inviteCode ? inviteCode.trim().toUpperCase() : null, accountType],
  );
  return (await companyRecord(account))!;
}

async function companyRecord(account: string): Promise<ChainCompany | null> {
  const { rows } = await db().query<{ account_id: string; account_type: AccountType; legal_name: string; country: string; created_ms: string }>(
    "select account_id, account_type, legal_name, country, (extract(epoch from created_at) * 1000)::bigint::text as created_ms from companies where account_id = $1",
    [account],
  );
  const r = rows[0];
  if (!r) return null;
  return { account_id: r.account_id, account_type: r.account_type, owner: r.account_id, legal_name: r.legal_name, country: r.country, created_at_ms: Number(r.created_ms), updated_at_ms: Number(r.created_ms) };
}

export async function isCompany(account: string): Promise<boolean> {
  const { rows } = await db().query("select 1 from companies where account_id = $1", [account]);
  return rows.length > 0;
}

export async function getBusiness(account: string): Promise<Company | null> {
  const record = await companyRecord(account);
  if (!record) return null;
  return withFormation(record);
}

export async function withFormation(chain: ChainCompany): Promise<Company> {
  const { rows } = await db()
    .query<{ legal_name: string; jurisdiction: Jurisdiction | null; status: CompanyStatus; application_hash: string | null; doc_hashes: string[] }>(
      "select legal_name, jurisdiction, status, application_hash, doc_hashes from formations where account_id = $1",
      [chain.account_id],
    )
    .catch(() => ({ rows: [] }));
  const f = rows[0];
  return {
    ...chain,
    legal_name: f?.legal_name ?? chain.legal_name,
    jurisdiction: f?.jurisdiction ?? null,
    status: f?.status ?? "draft",
    application_hash: f?.application_hash ?? null,
    doc_hashes: f?.doc_hashes ?? [],
  };
}

export async function recordFormation(account: string, legalName: string, jurisdiction: Jurisdiction, applicationHash: string) {
  await db().query(
    `insert into formations (account_id, legal_name, jurisdiction, application_hash) values ($1, $2, $3, $4)
     on conflict (account_id) do update set legal_name = excluded.legal_name, jurisdiction = excluded.jurisdiction,
       application_hash = excluded.application_hash, updated_at = now()`,
    [account, legalName, jurisdiction, applicationHash],
  );
}
