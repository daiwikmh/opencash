export const network = {
  id: "mainnet",
  rpc: "https://rpc.mainnet.fastnear.com",
  explorer: "https://nearblocks.io",
  parent: "opencash.near",
  contract: "registry.opencash.near",
  usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
} as const;

export const usdcAssetId = `nep141:${network.usdc}`;

export function txUrl(hash: string): string {
  return `${network.explorer}/txns/${hash}`;
}

export type AccountKind = "near" | "opencash" | "existing";

export const accountIdPattern = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function accountFor(kind: Exclude<AccountKind, "existing">, handle: string): string {
  return kind === "near" ? `${handle}.near` : `${handle}.${network.parent}`;
}

export function payUrlFor(base: string, invoice: { id: string; pay_key?: string }): string {
  return `${base}/pay?id=${encodeURIComponent(invoice.id)}${invoice.pay_key ? `&k=${encodeURIComponent(invoice.pay_key)}` : ""}`;
}

export function accountUrl(account: string): string {
  return `${network.explorer}/address/${account}`;
}
