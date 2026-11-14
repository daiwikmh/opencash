create table if not exists companies (
  account_id text primary key,
  legal_name text not null,
  country text not null,
  created_at timestamptz not null default now()
);

create table if not exists invoices (
  id text primary key,
  company text not null references companies (account_id),
  seq integer not null check (seq > 0),
  client_name text not null,
  items jsonb not null,
  amount_units numeric(30,0) not null check (amount_units > 0),
  due_ms bigint not null,
  source text not null check (source in ('direct', 'link', 'api', 'chat', 'topup')),
  reference text,
  details_hash text not null check (details_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'pending', 'paid', 'refunded')),
  deposit_address text,
  payment jsonb,
  settle_tx text,
  paid_at_ms bigint,
  issued boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company, seq)
);

create index if not exists invoices_company_idx on invoices (company, created_at desc);
create index if not exists invoices_pending_idx on invoices (created_at) where status = 'pending';
create index if not exists invoices_unissued_idx on invoices (created_at) where not issued;
