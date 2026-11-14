import { payoutStatusLabel, txUrl, type Invoice, type Payout } from "shared";
import { api } from "../lib/api";
import { date, errorText, esc, moneyHtml, query, say, short, statusTag, usdc } from "../lib/dom";
import { businessAuth } from "../lib/near";
import { showToast } from "../lib/toast";
import { bindRows } from "./invoices";
import { openModal } from "./modal";
import { payoutTone } from "./payouts";
import { state } from "./state";

type Activity = { at: number; html: string };

let payouts: Payout[] = [];

function sum(invoices: Invoice[]): string {
  return invoices.reduce((total, inv) => total + BigInt(inv.amount), 0n).toString();
}

export async function loadBalance() {
  if (!state.session) return;
  const { usdc: units } = await api.balance(state.session.accountId);
  query("[data-home-balance]").innerHTML = moneyHtml(units);
}

function incoming(inv: Invoice): Activity {
  const topup = inv.source === "topup";
  const route = inv.payment ? `${inv.payment.origin_asset} on ${inv.payment.origin_chain} → USDC` : "Any chain → USDC";
  const proof = inv.settle_tx ? ` <a href="${txUrl(inv.settle_tx)}" target="_blank" rel="noopener">↗</a>` : "";
  return {
    at: inv.paid_at_ms ?? inv.created_at_ms,
    html: `<tr${topup ? "" : ` data-invoice="${esc(inv.id)}"`}>
      <td class="cell-identity">↓ ${esc(topup ? "Top-up" : inv.client_name)}</td>
      <td class="cell-muted">${esc(route)}</td>
      <td class="cell-muted">${date(inv.paid_at_ms ?? inv.created_at_ms)}</td>
      <td>${statusTag(inv.status)}${proof}</td>
      <td class="cell-value">+${usdc(inv.amount)}</td>
    </tr>`,
  };
}

function outgoing(p: Payout): Activity {
  const proof = p.delivery_tx_url ? ` <a href="${esc(p.delivery_tx_url)}" target="_blank" rel="noopener">↗</a>` : p.transfer_tx ? ` <a href="${txUrl(p.transfer_tx)}" target="_blank" rel="noopener">↗</a>` : "";
  return {
    at: Date.parse(p.created_at),
    html: `<tr>
      <td class="cell-identity">↑ ${esc(p.payee_name)}</td>
      <td class="cell-muted">USDC → ${esc(`${p.amount_out} ${p.symbol} on ${p.chain}`)}</td>
      <td class="cell-muted">${date(Date.parse(p.created_at))}</td>
      <td><span class="tag tag--${payoutTone[p.status]}"><i class="tag__dot"></i>${payoutStatusLabel[p.status]}</span>${proof}</td>
      <td class="cell-value">−${usdc(p.amount_units)}</td>
    </tr>`,
  };
}

function renderActivity() {
  const wrap = query("[data-home-activity]");
  wrap.classList.remove("table-wrap--loading");
  const rows = [
    ...[...state.invoices, ...state.topups].filter((inv) => inv.status !== "open").map(incoming),
    ...payouts.filter((p) => p.status !== "quoted" && p.status !== "expired").map(outgoing),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  if (rows.length === 0) {
    wrap.innerHTML = `<p class="empty">Nothing has moved yet. Top up, send an invoice, or pay someone on any chain.</p>`;
    return;
  }
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>Who</th><th>Route</th><th>Date</th><th>Status</th><th class="cell-value">USDC</th></tr></thead><tbody>${rows.map((r) => r.html).join("")}</tbody></table>`;
  bindRows(wrap);
}

export async function loadActivity() {
  const session = state.session;
  if (!session) return;
  try {
    payouts = await api.payouts(await businessAuth(session, "list-payouts"));
  } catch {
    payouts = [];
  }
  renderActivity();
}

export function renderHome() {
  const { company, invoices, session } = state;
  if (!company || !session) return;
  query("[data-home-company]").textContent = company.legal_name;
  query("[data-home-account]").textContent = short(session.accountId);

  const month = new Date();
  month.setDate(1);
  month.setHours(0, 0, 0, 0);
  const paid = invoices.filter((inv) => inv.status === "paid" && inv.created_at_ms >= month.getTime());
  const waiting = invoices.filter((inv) => inv.status === "open" || inv.status === "pending");
  query("[data-stat-paid]").textContent = usdc(sum(paid));
  query("[data-stat-paid-sub]").textContent = `${paid.length} invoice${paid.length === 1 ? "" : "s"}`;
  query("[data-stat-open]").textContent = usdc(sum(waiting));
  query("[data-stat-open-sub]").textContent = `${waiting.length} invoice${waiting.length === 1 ? "" : "s"}`;
  renderActivity();
}

function openTopUp() {
  const session = state.session;
  if (!session) return;
  const account = session.accountId;
  const body = openModal(
    "Top up",
    `<p class="panel__lede">Add money from any chain. Pick the token you hold on the next page; it arrives here as USDC.</p>
     <form data-topup-form>
       <label class="field" style="margin-top:var(--sp-md)"><span>Amount (USD)</span><input name="amount" inputmode="decimal" placeholder="100" required /></label>
       <div class="btn-row" style="margin-top:var(--sp-md)"><button type="submit" class="btn btn--primary">Get a deposit address</button></div>
       <p class="status-line" data-topup-status role="status"></p>
     </form>
     <label class="field" style="margin-top:var(--sp-lg)"><span>Already have USDC on NEAR? Send it to</span><input readonly value="${esc(account)}" /></label>
     <div class="btn-row" style="margin-top:var(--sp-md)"><button type="button" class="btn" data-copy>Copy account</button></div>`,
  );
  query("[data-copy]", body).addEventListener("click", async () => {
    await navigator.clipboard.writeText(account);
    showToast("Account copied");
  });
  const form = query<HTMLFormElement>("[data-topup-form]", body);
  const status = query("[data-topup-status]", body);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tab = window.open("", "_blank");
    say(status, "Creating your deposit page…");
    try {
      const amount = String(new FormData(form).get("amount") ?? "").trim();
      const { pay_url } = await api.topUp(await businessAuth(session, "top-up"), amount);
      if (tab) tab.location.href = pay_url;
      else location.assign(pay_url);
      say(status, "Opened in a new tab. Your balance updates once it settles.");
    } catch (cause) {
      tab?.close();
      say(status, errorText(cause), "error");
    }
  });
}

export function initHome() {
  query("[data-home-refresh]").addEventListener("click", () => void Promise.all([loadBalance(), loadActivity()]));
  query("[data-open-receive]").addEventListener("click", openTopUp);
}
