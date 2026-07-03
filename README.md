# guru-clicksign-contracts

Backend que gera e coleta assinatura de contrato **em segundos após um
pagamento aprovado** no Digital Manager Guru, usando a **API v3 da Clicksign**
(JSON:API). O cliente assina via **widget embedded** na nossa página (sem
e-mail, sem sair do site); a Icomm assina automaticamente via
**auto_signature**.

> **Ambiente atual: SANDBOX da Clicksign** (`https://sandbox.clicksign.com/api/v3`).
> Nada aponta para produção — a troca é pela env `CLICKSIGN_BASE_URL`.

## Stack

**Supabase Edge Functions (TypeScript/Deno)** + Postgres + Storage, num
projeto Supabase dedicado. A lógica de negócio fica em módulos **puros** em
`supabase/functions/_shared/` (sem APIs Deno), testados com **vitest** em
Node; as functions são wrappers finos sobre esses módulos.

Decisão de projeto: **não geramos PDF**. Os contratos são .docx escritos pela
advocacia; preenchemos o próprio .docx por substituição de placeholders e a
Clicksign converte para PDF na subida do documento (Etapa 3). Isso preserva a
formatação jurídica 1:1 e dispensa Playwright/Chromium, que não roda em Edge
Functions.

## Pipeline (tabela `contracts`)

```
received → document_generated → envelope_created → running → closed
                (invalid / error em qualquer ponto)
```

| Etapa | Função | Status |
|---|---|---|
| 1. Webhook do Guru | `guru-webhook` | ✅ implementada |
| 2. Geração do documento do contrato | `generate-contract` | ✅ implementada |
| 3. Envelope na Clicksign (draft → docs → signers → requirements → running) | `create-envelope` | ✅ implementada |
| 4. Endpoint do widget embedded (chave de assinatura do cliente) | — | pendente |
| 5. Webhook de close da Clicksign (arquivar PDF, WhatsApp, CRM) | — | pendente |

## Etapa 1 — `guru-webhook`

`POST /functions/v1/guru-webhook` (público, `verify_jwt = false`)

1. Valida o `api_token` do corpo contra o secret `GURU_API_TOKEN`
   (comparação em tempo constante) → `401` se inválido.
2. Filtra `status === "approved"` — qualquer outro status responde `200` com
   `processed: false` (o Guru reenvia até receber 200; devolver erro num
   payload que nunca será processado só gera retries inúteis).
3. Extrai nome, CPF/CNPJ, e-mail, telefone, valor, plano (produto + oferta),
   marketplace, **plataforma** (campo customizado "Plataforma" do checkout,
   busca profunda no payload) e **forma de pagamento** (método + parcelas).
4. Grava em `contracts` com upsert idempotente por `guru_transaction_id`
   (reenvios do Guru não duplicam). O payload bruto fica em `raw_webhook`.
5. Dispara `generate-contract` (fire-and-forget, idempotente).

## Etapa 2 — `generate-contract`

Interna (exige service role no header Authorization).

- **Templates**: os 5 .docx da advocacia parametrizados com 10 placeholders —
  `{{CONTRATANTE_NOME}}`, `{{CONTRATANTE_CPF}}`, `{{CONTRATANTE_ENDERECO}}`,
  `{{PLATAFORMA}}`, `{{VALOR_BRUTO}}`, `{{VALOR_BRUTO_EXTENSO}}`,
  `{{VALOR_LIQUIDO}}`, `{{VALOR_LIQUIDO_EXTENSO}}`, `{{DATA_ASSINATURA}}`,
  `{{FORMA_PAGAMENTO}}`. Fonte em `supabase/templates/contracts/`; runtime lê
  do bucket privado `contract-templates`.
- **Seleção de template**: tabela `contract_templates` casa `match_patterns`
  contra o nome do plano (sem acento, case-insensitive; padrão mais longo
  vence). Trocar template = subir novo .docx + ajustar a linha na tabela,
  **sem redeploy**.
- **Valores**: `VALOR_LIQUIDO` = bruto − 6,15% (impostos da cláusula 3.1);
  valor por extenso em pt-BR (`_shared/money.ts`).
- **Plataforma (cláusula 1.1)**: campo "Plataforma" do checkout do Guru;
  fallback `contract_templates.default_platform` → "e-commerce".
- **Forma de pagamento (cláusula 3.1)**: método + parcelas + gateway reais
  (cartão 12x no Pagar.me reproduz o texto original; Pix → "por Pix, em
  parcela única"; boleto coberto).
- Saída: docx preenchido em `contracts-generated/<contract_id>/…​.docx`,
  status `document_generated`.

## Etapa 3 — `create-envelope`

Interna (exige service role no header Authorization); disparada pelo
`generate-contract` ao concluir. Lógica pura em `_shared/clicksign.ts`
(payloads JSON:API + orquestração com fetch injetável, testada no vitest).

Sequência na API v3 (`Authorization: <token>`, `Content-Type:
application/vnd.api+json` — confirmada na collection oficial
[docs-clicksign-api](https://github.com/clicksign/docs-clicksign-api)):

1. `POST /envelopes` — draft, `locale pt-BR`, `auto_close`.
2. `POST /envelopes/:id/documents` — docx gerado na Etapa 2 como
   `content_base64` (data URI; a Clicksign converte para PDF).
3. `POST /envelopes/:id/signers` — **cliente** (grupo 1, `refusable false`,
   CPF em `documentation`; compra por CNPJ vai sem CPF) e **Icomm** (grupo 2,
   dados do secret `ICOMM_SIGNER_*`, idênticos ao Termo de Assinatura
   Automática).
4. `POST /envelopes/:id/requirements` — 4 requisitos: assinar (`agree/sign`)
   para cada signatário + autenticação (`provide_evidence`): cliente com
   `auth` do secret `CLICKSIGN_CLIENT_AUTH` (padrão `email`; trocar para
   `embedded_signature` quando a Clicksign liberar o widget para conta +
   domínio) e Icomm com `auth: auto_signature`.
5. `PATCH /envelopes/:id` → `status running` (os ids são persistidos ANTES da
   ativação; se ela falhar, o contrato fica em `envelope_created` e um retry
   retoma só a ativação).

O `key` do signatário cliente (devolvido no passo 3) fica em
`contracts.clicksign_signer_key` — é ele que carrega o widget embedded na
página (Etapa 4).

## Setup do zero (mastigado)

Pré-requisitos: [Supabase CLI](https://supabase.com/docs/guides/cli) e Node 20+.

```bash
# 0. dependências e testes
npm install
npm test

# 1. criar projeto no Supabase (supabase.com → New project) e vincular
supabase login
supabase link --project-ref <ref-do-projeto>   # ref aparece na URL do painel

# 2. aplicar o schema (tabelas, seeds dos templates, buckets)
supabase db push

# 3. secrets das functions
supabase secrets set GURU_API_TOKEN=<token do painel do Guru>
supabase secrets set CLICKSIGN_API_TOKEN=<token da conta SANDBOX>
supabase secrets set CLICKSIGN_BASE_URL=https://sandbox.clicksign.com/api/v3
supabase secrets set CLICKSIGN_CLIENT_AUTH=email
# dados EXATOS do Termo de Assinatura Automática assinado na conta Clicksign
supabase secrets set ICOMM_SIGNER_NAME="<nome>"
supabase secrets set ICOMM_SIGNER_EMAIL=<email>
supabase secrets set ICOMM_SIGNER_BIRTHDAY=<YYYY-MM-DD>
supabase secrets set ICOMM_SIGNER_DOCUMENTATION=<CPF 000.000.000-00>

# 4. deploy das functions
supabase functions deploy guru-webhook
supabase functions deploy generate-contract
supabase functions deploy create-envelope

# 5. subir os templates de contrato para o Storage
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
npm run upload-templates
```

No painel do Guru: **Configurações → Webhooks → Adicionar**, URL
`https://<ref>.supabase.co/functions/v1/guru-webhook`, marcando só o status
**Aprovado**. Dispare o envio de teste e confira a tabela `contracts` e o
bucket `contracts-generated`.

Teste manual do fluxo completo:

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/guru-webhook" \
  -H "Content-Type: application/json" \
  -d '{"api_token":"<GURU_API_TOKEN>","id":"teste-001","status":"approved",
       "contact":{"name":"Maria Teste","doc":"123.456.789-09","email":"maria@teste.com"},
       "payment":{"total":20000,"method":"pix","marketplace_name":"pagarme"},
       "product":{"name":"Mentoria ADS"},
       "extras":[{"name":"Plataforma","value":"Shopee"}]}'
```

## Scripts

- `scripts/parametrize_contract_templates.py <dir>` — converte os .docx
  originais da advocacia em templates com placeholders (uso único/quando o
  jurídico atualizar os contratos).
- `scripts/upload-contract-templates.mjs` — sobe os templates para o bucket.

## TODOs externos (config, não código)

- [ ] **Termo de Assinatura Automática** da Icomm assinado na conta Clicksign
      (pré-requisito do `auto_signature`; os dados do signatário Icomm na
      Etapa 3 devem ser idênticos aos do termo, letra por letra).
- [ ] **Liberação do Widget Embedded** pela Clicksign para a conta + domínio
      do site onde o cliente assina.
- [ ] Campo customizado **"Plataforma"** no checkout dos 5 produtos no Guru.
- [ ] Confirmar no primeiro webhook real os caminhos dos campos do payload
      (a extração é tolerante e o `raw_webhook` fica salvo para conferência).
- [ ] **Primeira rodada no sandbox da Clicksign**: a Etapa 3 foi escrita a
      partir da documentação e da collection oficial, mas ainda não rodou
      contra o sandbox (sem token nesta máquina). Erros da API ficam em
      `contracts.error` com o detail JSON:API — ajustar o que aparecer.
- [ ] Respeitar o **rate limit** da API Clicksign (fila/backoff se o volume crescer).
- [ ] Definir tratamento de **estorno após contrato assinado** (hoje o webhook
      ignora `refunded`/`chargeback`).

## Etapas 4–5 (planejado)

- **Etapa 4**: endpoint que devolve `contracts.clicksign_signer_key` para a
  página pós-pagamento carregar o widget embedded da Clicksign
  (github.com/clicksign/widget). Depende da liberação do widget pela
  Clicksign; até lá o cliente autentica por token de e-mail
  (`CLICKSIGN_CLIENT_AUTH=email`).
- **Etapa 5**: webhook de `envelope closed` → baixa o PDF assinado para o
  Storage (`signed_pdf_path`), notifica no WhatsApp e atualiza o CRM.
