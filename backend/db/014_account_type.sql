alter table companies add column if not exists account_type text not null default 'business' check (account_type in ('business', 'personal'));
