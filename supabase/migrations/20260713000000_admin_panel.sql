-- Painel administrativo: acesso via Supabase Auth restrito a admins.
--
-- admin_users: whitelist de quem pode usar o painel. Cadastro é manual
-- (SQL/dashboard) — não há signup aberto virando admin.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

-- security definer: consulta a whitelist ignorando RLS (senão is_admin
-- nunca conseguiria ler a própria tabela)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

create policy "admins leem a lista de admins" on public.admin_users
  for select using (public.is_admin());

-- Catálogo de modelos: admins gerenciam pelo painel (criar/editar/desativar)
create policy "admins gerenciam templates" on public.contract_templates
  for all using (public.is_admin()) with check (public.is_admin());

-- Contratos: admins acompanham o pipeline (somente leitura; escrita continua
-- exclusiva das edge functions via service role)
create policy "admins leem contratos" on public.contracts
  for select using (public.is_admin());

-- Storage: admins sobem/trocam modelos e baixam os contratos gerados
create policy "admins gerenciam bucket de templates" on storage.objects
  for all using (bucket_id = 'contract-templates' and public.is_admin())
  with check (bucket_id = 'contract-templates' and public.is_admin());

create policy "admins leem contratos gerados" on storage.objects
  for select using (bucket_id = 'contracts-generated' and public.is_admin());
