# Submission: What did you build?

opencash: global finance for people. Live at https://opencash.in (invite code for judges: NEARJUDGES).

The problem: a freelancer in Lagos, a two-person studio in Bangalore or a small team in Manila works for clients all over the world, but getting paid across borders is slow and expensive, paying collaborators abroad is worse, and the tools that fix it (a company, a business account, contracts, payroll) are built for people in a handful of countries.

What we built: one account in US dollars that anyone can open in a minute with a fingerprint or face scan. No bank visit, no paperwork, nothing to install. From it you can:
- Invoice a client or share a payment link; they pay with whatever they already use, and you receive exactly the amount you billed.
- Pay a contractor or run payroll for a team in one approval, each person paid the way they choose.
- Turn an invoice into a contract and sign it with the same fingerprint.
- Prepare a US company application with an AI advisor that recommends the right structure for where you live.
- Run it from Telegram: "request 50 from Acme" sends a pay link; "pay Ada 20" sends a link only you can approve.
- Give an AI agent its own wallet with hard spending limits, so it can pay for services without touching your main account.
- Hand your accountant CSV exports and a guide written for them.

Your clients and the people you pay never need an account.

How NEAR fits in: NEAR is the ledger underneath. Each account is a NEAR account controlled only by the owner's passkey, so opencash never holds anyone's money. NEAR Intents converts payments in and out automatically, with refunds if anything fails. opencash pays all network fees, and a NEAR contract records every invoice's amount and final status, so payment is provable without making client names or prices public.

Verified live: an invoice for $1.00 was paid from another network in about 30 seconds, and exactly $1.00 arrived and was recorded as paid.
