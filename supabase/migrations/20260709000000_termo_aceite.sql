-- Termo de Ciência e Aceite: o cliente marca o checkbox na página pós-compra
-- antes de assinar. Guardamos o momento e o IP como evidência do aceite.
alter table public.contracts
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_accepted_ip text;
