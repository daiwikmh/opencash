import { setTimeout as sleep } from "node:timers/promises";
import { Account, JsonRpcProvider, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import type { AccountKind, Company } from "shared";
import { registerCompany, withFormation } from "./business.js";
import { config } from "./config.js";

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

let operatorAccount: Account | null = null;

export function operator(): Account {
  operatorAccount ??= new Account(config.parent, provider, config.operatorKey() as KeyPairString);
  return operatorAccount;
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId: config.contract, method, args })) as T;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export async function usdcBalance(accountId: string): Promise<string> {
  const result = await provider.callFunction({ contractId: config.usdc, method: "ft_balance_of", args: { account_id: accountId } });
  return String(result ?? "0");
}

export async function hasFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  try {
    const key = await provider.viewAccessKey({ accountId, publicKey });
    return key.permission === "FullAccess";
  } catch {
    return false;
  }
}

async function createAccount(kind: Exclude<AccountKind, "existing">, accountId: string, publicKey: string): Promise<string> {
  const parent = operator();
  const deposit = nearToYocto(config.newAccountNear as `${number}`);
  if (kind === "opencash") {
    const created = await parent.createSubAccount({ accountOrPrefix: accountId.slice(0, -(config.parent.length + 1)), publicKey, nearToTransfer: deposit });
    return created.transaction.hash;
  }
  const outcome = await parent.callFunctionRaw({
    contractId: "near",
    methodName: "create_account",
    args: { new_account_id: accountId, new_public_key: publicKey },
    deposit,
    gas: teraToGas(50),
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await accountExists(accountId)) return outcome.transaction.hash;
    await sleep(1_000);
  }
  throw Object.assign(new Error(`NEAR could not create ${accountId}. Pick another name.`), { statusCode: 409 });
}

export async function openCompany(input: {
  kind: AccountKind;
  accountId: string;
  publicKey: string;
  legalName: string;
  country: string;
  inviteCode?: string;
}): Promise<{ company: Company; txHash: string | null }> {
  const parent = operator();
  const accountId = input.accountId;
  const txHash = input.kind === "existing" ? null : await createAccount(input.kind, accountId, input.publicKey);
  await parent.callFunction({
    contractId: config.usdc,
    methodName: "storage_deposit",
    args: { account_id: accountId, registration_only: true },
    deposit: nearToYocto("0.00125"),
    gas: teraToGas(30),
  });
  const company = await registerCompany(accountId, input.legalName, input.country, input.inviteCode);
  return { company: await withFormation(company), txHash };
}
