export const site = {
  name: "opencash",
  network: "NEAR",
  dashboardPath: "/app",
  launchEnabled: true,
  description:
    "opencash is business payments on NEAR: invoices, payment links and a checkout API that accept any token on any chain, payouts and payroll to any chain, from the dashboard or a chat, all settling in USDC with no gas.",
  shareTitle: "opencash — Business payments for the world",
  shareDescription:
    "Get paid from any chain, pay anyone on any chain. Invoices, links, checkout API, payouts and payroll in USDC on NEAR, signed with a passkey.",
} as const;

export const navLinks = [
  { href: "#home", label: "Home" },
  { href: "#about", label: "Why" },
  { href: "#platform", label: "How it works" },
  { href: "#assets", label: "Products" },
  { href: "#network", label: "Developers" },
] as const;

export const footerLinks = [
  { href: "#about", label: "Why opencash" },
  { href: "#platform", label: "How it works" },
  { href: "#assets", label: "Products" },
  { href: "#network", label: "Developers" },
] as const;
