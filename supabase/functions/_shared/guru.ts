// Lógica pura do webhook de transações do Digital Manager Guru.
// Sem APIs Deno/Node aqui: este módulo é importado tanto pela edge function
// (Deno) quanto pelos testes em vitest (Node).
//
// Referência: https://docs.digitalmanager.guru/developers/webhook-para-transacoes
// O Guru envia um POST JSON por transação com `api_token` no corpo e reenvia
// até receber HTTP 200. Os caminhos de campo abaixo cobrem o formato padrão
// e alguns sinônimos; o payload bruto é sempre persistido em `raw_webhook`
// para permitir reprocessamento se algum caminho divergir.

export interface GuruSale {
  /** ID da transação no Guru (chave de idempotência) */
  transactionId: string;
  customerName: string;
  /** Documento normalizado: só dígitos (11 = CPF, 14 = CNPJ) */
  customerDoc: string;
  docType: "cpf" | "cnpj";
  customerEmail: string;
  customerPhone: string | null;
  /** Valor total pago */
  amount: number | null;
  /** Nome do produto/plano (+ oferta, quando presente) */
  planName: string;
  marketplace: string | null;
  /** Plataforma de vendas do cliente (campo "Plataforma" do checkout do Guru) — cláusula 1.1 */
  platform: string | null;
  /** Método de pagamento do Guru (credit_card, pix, billet...) — cláusula 3.1 */
  paymentMethod: string | null;
  /** Número de parcelas, quando houver */
  installments: number | null;
  status: string;
}

export type GuruWebhookResult =
  | { kind: "unauthorized"; reason: string }
  | { kind: "ignored"; reason: string; status?: string }
  | { kind: "invalid"; reason: string; missing: string[] }
  | { kind: "accepted"; sale: GuruSale };

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // aceita "297.00" e "297,00"
    const n = Number(v.replace(/\./g, (m, i, s) => (s.includes(",") ? "" : m)).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function onlyDigits(v: string): string {
  return v.replace(/\D/g, "");
}

export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Comparação em tempo constante para o api_token — evita que um atacante
 * descubra o token por timing (o endpoint é público, sem verify_jwt).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Status do Guru que disparam a geração de contrato. */
export const APPROVED_STATUSES = new Set(["approved"]);

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Procura em profundidade um campo chamado "plataforma" no payload — o dado
 * vem de um campo customizado do checkout do Guru e a posição exata no JSON
 * varia (extras, custom_fields, contact...). Cobre dois formatos:
 *   { plataforma: "Shopee" }
 *   { name/label: "Plataforma", value/answer: "Shopee" }
 */
export function findPlatformField(node: unknown, depth = 0): string | null {
  if (depth > 6 || !node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPlatformField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const obj = node as Json;

  const labelKey = asString(obj.name) ?? asString(obj.label) ?? asString(obj.field);
  if (labelKey && stripAccents(labelKey) === "plataforma") {
    const value = asString(obj.value) ?? asString(obj.answer);
    if (value) return value;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (stripAccents(key) === "plataforma") {
      const v = asString(value);
      if (v) return v;
    }
  }

  for (const value of Object.values(obj)) {
    const found = findPlatformField(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Extrai os dados da venda do payload do Guru, tolerando variações de caminho.
 * Retorna também a lista de campos obrigatórios ausentes.
 */
export function extractSale(payload: Json): { sale: Partial<GuruSale>; missing: string[] } {
  const contact = asObject(payload.contact) ?? {};
  const payment = asObject(payload.payment) ?? {};
  const product = asObject(payload.product) ?? {};
  const offer = asObject(product.offer) ?? {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const firstItem = asObject(items[0]) ?? {};

  const transactionId =
    asString(payload.id) ?? asString(payload.transaction_id) ?? null;

  const customerName = asString(contact.name) ?? null;

  const docRaw = asString(contact.doc) ?? asString(contact.document) ?? "";
  const customerDoc = onlyDigits(docRaw);
  const docType: GuruSale["docType"] = customerDoc.length === 14 ? "cnpj" : "cpf";

  const emailRaw = asString(contact.email) ?? "";
  const customerEmail = isValidEmail(emailRaw) ? emailRaw : null;

  const phoneCode = asString(contact.phone_local_code) ?? "";
  const phoneNum = asString(contact.phone_number) ?? "";
  const customerPhone = phoneNum ? onlyDigits(phoneCode + phoneNum) || null : null;

  const amount =
    asNumber(payment.total) ??
    asNumber(payment.gross) ??
    asNumber(product.total_value) ??
    asNumber(firstItem.total_value) ??
    null;

  const productName = asString(product.name) ?? asString(firstItem.name) ?? null;
  const offerName = asString(offer.name);
  const planName = productName
    ? offerName && offerName !== productName
      ? `${productName} — ${offerName}`
      : productName
    : null;

  const marketplace =
    asString(payment.marketplace_name) ??
    asString(product.marketplace_name) ??
    asString(firstItem.marketplace_name) ??
    null;

  const platform = findPlatformField(payload);

  const creditCard = asObject(payment.credit_card) ?? {};
  const paymentMethod = asString(payment.method)?.toLowerCase() ?? null;
  const installments =
    asNumber(payment.installments) ??
    asNumber(creditCard.installments) ??
    null;

  const status = asString(payload.status)?.toLowerCase() ?? "";

  const missing: string[] = [];
  if (!transactionId) missing.push("id (transação)");
  if (!customerName) missing.push("contact.name");
  if (!(customerDoc.length === 11 || customerDoc.length === 14)) missing.push("contact.doc (CPF/CNPJ)");
  if (!customerEmail) missing.push("contact.email");
  if (!planName) missing.push("product.name");

  return {
    sale: {
      transactionId: transactionId ?? undefined,
      customerName: customerName ?? undefined,
      customerDoc,
      docType,
      customerEmail: customerEmail ?? undefined,
      customerPhone,
      amount,
      planName: planName ?? undefined,
      marketplace,
      platform,
      paymentMethod,
      installments,
      status,
    },
    missing,
  };
}

/**
 * Pipeline completo da Etapa 1: autentica, filtra status e extrai dados.
 *
 * Regras de resposta HTTP (decididas pelo chamador a partir do `kind`):
 * - unauthorized → 401 (não veio do Guru; deixar o Guru/atacante sem 200)
 * - ignored/invalid/accepted → 200 (o Guru reenvia até receber 200; para
 *   payloads que nunca vamos processar, reenviar não ajuda)
 */
export function processGuruWebhook(body: unknown, expectedToken: string): GuruWebhookResult {
  const payload = asObject(body);
  if (!payload) {
    return { kind: "ignored", reason: "corpo não é um objeto JSON" };
  }

  const token = asString(payload.api_token) ?? "";
  if (!expectedToken || !token || !timingSafeEqual(token, expectedToken)) {
    return { kind: "unauthorized", reason: "api_token ausente ou inválido" };
  }

  const status = asString(payload.status)?.toLowerCase() ?? "";
  if (!APPROVED_STATUSES.has(status)) {
    return { kind: "ignored", reason: `status '${status || "?"}' não é venda aprovada`, status };
  }

  const { sale, missing } = extractSale(payload);
  if (missing.length > 0) {
    return { kind: "invalid", reason: "payload aprovado sem campos obrigatórios", missing };
  }

  return { kind: "accepted", sale: sale as GuruSale };
}
