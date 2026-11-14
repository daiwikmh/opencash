alter table invoices add column if not exists pay_key text not null default replace(gen_random_uuid()::text, '-', '');
