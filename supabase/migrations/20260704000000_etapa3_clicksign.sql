-- Etapa 3: colunas para o envelope da Clicksign.
-- clicksign_signer_key: `key` do signatário cliente devolvido na criação —
--   é o que carrega o widget embedded na página (Etapa 4).
-- clicksign_icomm_signer_id: signatário da assinatura automática (grupo 2).
alter table public.contracts
  add column if not exists clicksign_signer_key text,
  add column if not exists clicksign_icomm_signer_id text;
