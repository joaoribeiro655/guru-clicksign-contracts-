-- Fluxo Guru → Clicksign: schema inicial.
--
-- contracts: um registro por venda aprovada no Guru, acompanhando o ciclo
--   received → document_generated → envelope_created → running → closed
--   (invalid = webhook aprovado sem dados obrigatórios; error = falha em etapa)
create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  guru_transaction_id text not null,
  customer_name text,
  customer_doc text,
  doc_type text check (doc_type in ('cpf', 'cnpj')),
  customer_email text,
  customer_phone text,
  amount numeric(12, 2),
  plan_name text,
  marketplace text,
  -- plataforma de vendas do cliente (campo "Plataforma" do checkout) — cláusula 1.1
  platform text,
  -- forma de pagamento real — cláusula 3.1
  payment_method text,
  installments integer,
  status text not null default 'received',
  -- Etapa 2: documento gerado
  template_key text,
  generated_doc_path text,
  -- Etapa 3: identificadores da Clicksign
  clicksign_envelope_id text,
  clicksign_document_id text,
  clicksign_signer_id text,
  -- Etapa 5: PDF assinado arquivado no Storage
  signed_pdf_path text,
  error text,
  raw_webhook jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotência do webhook: uma transação do Guru = um contrato
create unique index if not exists contracts_guru_transaction_id_key
  on public.contracts (guru_transaction_id);

create index if not exists contracts_status_idx on public.contracts (status);
create index if not exists contracts_customer_email_idx on public.contracts (customer_email);

-- Sem policies: acesso apenas via service role (edge functions)
alter table public.contracts enable row level security;

create or replace function public.contracts_set_updated_at()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists contracts_updated_at on public.contracts;
create trigger contracts_updated_at
  before update on public.contracts
  for each row execute function public.contracts_set_updated_at();

-- contract_templates: catálogo dos modelos .docx (fonte versionada em
-- supabase/templates/contracts/, subida ao Storage via
-- scripts/upload-contract-templates.mjs)
create table if not exists public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  title text not null,
  -- caminho no bucket contract-templates
  storage_path text not null,
  -- padrões casados contra o nome do plano vendido no Guru (sem acento,
  -- case-insensitive; o mais longo vence)
  match_patterns text[] not null default '{}',
  -- fallback da cláusula 1.1 quando a venda não traz o campo "Plataforma"
  default_platform text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.contract_templates enable row level security;

insert into public.contract_templates (key, title, storage_path, match_patterns) values
  ('mentoria-iniciante-04', 'Mentoria Iniciante — 04 encontros', 'mentoria-iniciante-04.docx',
   array['mentoria iniciante']),
  ('mentoria-ads-04', 'Mentoria ADS — 04 encontros', 'mentoria-ads-04.docx',
   array['mentoria ads']),
  ('consultoria-12', 'Consultoria — 12 encontros', 'consultoria-12.docx',
   array['consultoria 12', '12 encontros']),
  ('consultoria-tracao-15', 'Consultoria Tração 15 — 15 encontros', 'consultoria-tracao-15.docx',
   array['tracao 15', '15 encontros', 'consultoria 15']),
  ('consultoria-digital-business-16', 'Consultoria Digital Business — 16 encontros', 'consultoria-digital-business-16.docx',
   array['digital business', '16 encontros', 'consultoria 16'])
on conflict (key) do nothing;

-- Buckets privados: templates fonte e contratos gerados
insert into storage.buckets (id, name, public)
values
  ('contract-templates', 'contract-templates', false),
  ('contracts-generated', 'contracts-generated', false)
on conflict (id) do nothing;
