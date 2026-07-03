// Cliente da API v3 da Clicksign (JSON:API) — Etapa 3 do fluxo Guru → Clicksign.
// Módulo puro (sem APIs Deno) — testado via vitest em Node; o fetch é injetável.
//
// Referências (consultadas antes de codar, como manda o plano):
// - developers.clicksign.com/docs/envelope (fluxo draft → docs → signers →
//   requirements → running)
// - developers.clicksign.com/docs/tipos-de-requisitos-de-autenticacao
//   (auth: "email", "auto_signature", "embedded_signature", ...)
// - Collection oficial github.com/clicksign/docs-clicksign-api (payloads exatos)
//
// Headers da API: `Authorization: <token>` (sem "Bearer") e
// `Content-Type: application/vnd.api+json`.

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** bytes → base64 (em blocos: docx de contrato passa fácil de 64 KB) */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** content_base64 no formato data URI exigido pelo upload de documentos */
export function docxToContentBase64(bytes: Uint8Array): string {
  return `data:${DOCX_MIME};base64,${bytesToBase64(bytes)}`;
}

// ---------------------------------------------------------------------------
// Payloads JSON:API

export function buildEnvelopePayload(name: string) {
  return {
    data: {
      type: "envelopes",
      attributes: {
        name,
        locale: "pt-BR",
        // fecha sozinho quando todos assinarem (cliente + auto da Icomm)
        auto_close: true,
      },
    },
  };
}

export function buildDocumentPayload(filename: string, contentBase64: string) {
  return {
    data: {
      type: "documents",
      attributes: { filename, content_base64: contentBase64 },
    },
  };
}

export interface ClientSignerInput {
  name: string;
  email: string;
  phoneNumber: string | null;
  /** CPF/CNPJ formatado (formatDoc de contract-data.ts) */
  documentation: string | null;
  /** 'cpf' | 'cnpj' | null — documentation na Clicksign é CPF de pessoa física */
  docType: string | null;
}

/**
 * Signatário cliente — assina primeiro (group 1) pelo widget embedded.
 * Compra por CNPJ: quem assina é a pessoa representante, e o CNPJ não é um
 * CPF válido para a Clicksign — vai sem documentation (has_documentation
 * false, como estrangeiros/sem CPF).
 */
export function buildClientSignerPayload(input: ClientSignerInput) {
  const hasCpf = input.docType === "cpf" && !!input.documentation;
  return {
    data: {
      type: "signers",
      attributes: {
        name: input.name,
        email: input.email,
        phone_number: input.phoneNumber,
        has_documentation: hasCpf,
        ...(hasCpf ? { documentation: input.documentation } : {}),
        refusable: false,
        group: 1,
      },
    },
  };
}

export interface AutoSignerInput {
  /** Dados IDÊNTICOS ao Termo de Assinatura Automática assinado na conta */
  name: string;
  email: string;
  /** YYYY-MM-DD */
  birthday: string;
  /** CPF formatado */
  documentation: string;
}

/** Signatário Icomm — assinatura automática depois do cliente (group 2). */
export function buildAutoSignerPayload(input: AutoSignerInput) {
  return {
    data: {
      type: "signers",
      attributes: {
        name: input.name,
        email: input.email,
        birthday: input.birthday,
        has_documentation: true,
        documentation: input.documentation,
        refusable: false,
        group: 2,
      },
    },
  };
}

function requirementRelationships(documentId: string, signerId: string) {
  return {
    document: { data: { type: "documents", id: documentId } },
    signer: { data: { type: "signers", id: signerId } },
  };
}

/** Requisito de qualificação: o signatário assina (papel "sign") */
export function buildSignRequirementPayload(documentId: string, signerId: string) {
  return {
    data: {
      type: "requirements",
      attributes: { action: "agree", role: "sign" },
      relationships: requirementRelationships(documentId, signerId),
    },
  };
}

/**
 * Requisito de autenticação. Valores usados aqui:
 * - cliente: "email" (token por e-mail dentro do widget) até a Clicksign
 *   liberar o widget embedded para a conta+domínio; depois "embedded_signature"
 * - Icomm: "auto_signature" (exige Termo de Assinatura Automática vigente)
 */
export function buildAuthRequirementPayload(
  documentId: string,
  signerId: string,
  auth: string,
) {
  return {
    data: {
      type: "requirements",
      attributes: { action: "provide_evidence", auth },
      relationships: requirementRelationships(documentId, signerId),
    },
  };
}

export function buildActivateEnvelopePayload(envelopeId: string) {
  return {
    data: {
      id: envelopeId,
      type: "envelopes",
      attributes: { status: "running" },
    },
  };
}

// ---------------------------------------------------------------------------
// Cliente HTTP

export interface ClicksignConfig {
  /** ex.: https://sandbox.clicksign.com/api/v3 (sem barra final) */
  baseUrl: string;
  apiToken: string;
  fetchFn?: typeof fetch;
}

export class ClicksignApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "ClicksignApiError";
  }
}

interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

/** Extrai mensagens do corpo de erro JSON:API ({errors: [{title, detail}]}) */
function errorDetails(body: unknown): string {
  const errors = (body as { errors?: unknown })?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return JSON.stringify(body);
  return errors
    .map((e) => {
      const err = e as Record<string, unknown>;
      return [err.title, err.detail, err.source && JSON.stringify(err.source)]
        .filter(Boolean)
        .join(": ");
    })
    .join("; ");
}

export async function clicksignRequest(
  config: ClicksignConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: unknown,
): Promise<JsonApiResource> {
  const fetchFn = config.fetchFn ?? fetch;
  const url = `${config.baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetchFn(url, {
    method,
    headers: {
      Authorization: config.apiToken,
      "Content-Type": "application/vnd.api+json",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    throw new ClicksignApiError(
      `Clicksign ${method} ${path} → ${res.status}: ${errorDetails(body)}`,
      res.status,
      path,
    );
  }
  return (body as { data: JsonApiResource }).data;
}

// ---------------------------------------------------------------------------
// Orquestração da Etapa 3

export interface CreateEnvelopeInput {
  envelopeName: string;
  docxFilename: string;
  /** data URI (docxToContentBase64) */
  contentBase64: string;
  client: ClientSignerInput;
  /** auth do cliente: "email" | "embedded_signature" (ver buildAuthRequirementPayload) */
  clientAuth: string;
  icomm: AutoSignerInput;
}

export interface EnvelopeResources {
  envelopeId: string;
  documentId: string;
  /** signatário cliente — o `key` carrega o widget embedded (Etapa 4) */
  clientSignerId: string;
  clientSignerKey: string | null;
  icommSignerId: string;
}

/**
 * Cria envelope + documento + 2 signatários + 4 requisitos (draft).
 * A ativação é separada (activateEnvelope) para o chamador poder persistir os
 * ids antes — se a ativação falhar, o contrato fica em envelope_created com
 * os ids salvos e dá para retomar/diagnosticar.
 */
export async function createEnvelopeResources(
  config: ClicksignConfig,
  input: CreateEnvelopeInput,
): Promise<EnvelopeResources> {
  const envelope = await clicksignRequest(
    config,
    "POST",
    "/envelopes",
    buildEnvelopePayload(input.envelopeName),
  );
  const base = `/envelopes/${envelope.id}`;

  const document = await clicksignRequest(
    config,
    "POST",
    `${base}/documents`,
    buildDocumentPayload(input.docxFilename, input.contentBase64),
  );

  const clientSigner = await clicksignRequest(
    config,
    "POST",
    `${base}/signers`,
    buildClientSignerPayload(input.client),
  );
  const icommSigner = await clicksignRequest(
    config,
    "POST",
    `${base}/signers`,
    buildAutoSignerPayload(input.icomm),
  );

  // Qualificação (assinar) e autenticação, para cada signatário
  await clicksignRequest(
    config,
    "POST",
    `${base}/requirements`,
    buildSignRequirementPayload(document.id, clientSigner.id),
  );
  await clicksignRequest(
    config,
    "POST",
    `${base}/requirements`,
    buildSignRequirementPayload(document.id, icommSigner.id),
  );
  await clicksignRequest(
    config,
    "POST",
    `${base}/requirements`,
    buildAuthRequirementPayload(document.id, clientSigner.id, input.clientAuth),
  );
  await clicksignRequest(
    config,
    "POST",
    `${base}/requirements`,
    buildAuthRequirementPayload(document.id, icommSigner.id, "auto_signature"),
  );

  return {
    envelopeId: envelope.id,
    documentId: document.id,
    clientSignerId: clientSigner.id,
    clientSignerKey: (clientSigner.attributes?.key as string | undefined) ?? null,
    icommSignerId: icommSigner.id,
  };
}

/** draft → running: dispara o fluxo de assinatura */
export async function activateEnvelope(
  config: ClicksignConfig,
  envelopeId: string,
): Promise<void> {
  await clicksignRequest(
    config,
    "PATCH",
    `/envelopes/${envelopeId}`,
    buildActivateEnvelopePayload(envelopeId),
  );
}
