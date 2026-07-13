// Seleção de template e montagem dos dados que preenchem o contrato.
// Módulo puro (sem APIs Deno) — testado via vitest em Node.
import { formatBRL, valorLiquido, valorPorExtenso } from "./money.ts";

/**
 * Os 10 placeholders oficiais que o generate-contract sabe preencher.
 * Um template novo pode usar um subconjunto; qualquer placeholder FORA desta
 * lista nunca será preenchido (o preenchimento falha de propósito).
 */
export const KNOWN_PLACEHOLDERS = [
  "CONTRATANTE_NOME",
  "CONTRATANTE_CPF",
  "CONTRATANTE_ENDERECO",
  "PLATAFORMA",
  "VALOR_BRUTO",
  "VALOR_BRUTO_EXTENSO",
  "VALOR_LIQUIDO",
  "VALOR_LIQUIDO_EXTENSO",
  "DATA_ASSINATURA",
  "FORMA_PAGAMENTO",
] as const;

export interface ContractTemplateRow {
  key: string;
  title: string;
  storage_path: string;
  match_patterns: string[];
  default_platform: string | null;
  active: boolean;
}

/** minúsculas + sem acentos, para casar padrões com nomes de plano */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Escolhe o template cujo padrão casa com o nome do plano vendido.
 * Padrão mais longo vence (mais específico); empate resolve por key.
 */
export function selectTemplate(
  planName: string,
  templates: ContractTemplateRow[],
): ContractTemplateRow | null {
  const plan = normalize(planName);
  let best: { row: ContractTemplateRow; len: number } | null = null;
  for (const row of templates) {
    if (!row.active) continue;
    for (const pattern of row.match_patterns) {
      const p = normalize(pattern);
      if (!p || !plan.includes(p)) continue;
      if (!best || p.length > best.len || (p.length === best.len && row.key < best.row.key)) {
        best = { row, len: p.length };
      }
    }
  }
  return best?.row ?? null;
}

/** "12345678909" → "123.456.789-09"; 14 dígitos → CNPJ formatado */
export function formatDoc(digits: string): string {
  if (digits.length === 11) {
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  }
  if (digits.length === 14) {
    return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  }
  return digits;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

/**
 * Monta o endereço do contratante a partir do contact do webhook do Guru.
 * Só inclui as partes presentes; endereços incompletos são comuns em checkout.
 */
export function buildAddress(contact: Record<string, unknown>): string {
  const street = str(contact.address) ?? str(contact.address_street);
  const number = str(contact.address_number) ?? str(contact.address_num);
  const comp = str(contact.address_comp) ?? str(contact.address_complement);
  const district = str(contact.address_district) ?? str(contact.address_neighborhood);
  const zip = str(contact.address_zip_code) ?? str(contact.address_cep) ?? str(contact.zip_code);
  const city = str(contact.address_city) ?? str(contact.city);
  const state = str(contact.address_state) ?? str(contact.state);

  const partes: string[] = [];
  if (street) partes.push(street);
  if (number) partes.push(`nº ${number}`);
  if (comp) partes.push(comp);
  if (district) partes.push(`Bairro ${district}`);
  if (zip) partes.push(`CEP ${zip}`);
  if (city) partes.push(state ? `${city}/${state}` : city);

  return partes.length > 0 ? partes.join(", ") : "endereço não informado";
}

/** Nome de exibição dos gateways/marketplaces mais comuns no Guru */
const MARKETPLACE_LABELS: Record<string, string> = {
  pagarme: "Pagar.me",
  "pagar.me": "Pagar.me",
  mercadopago: "Mercado Pago",
  hotmart: "Hotmart",
  eduzz: "Eduzz",
  kiwify: "Kiwify",
  stripe: "Stripe",
  asaas: "Asaas",
};

export interface PaymentInfo {
  method: string | null; // credit_card, pix, billet, boleto...
  installments: number | null;
  marketplace: string | null; // marketplace_name do Guru
}

/**
 * Texto da cláusula 3.1 ({{FORMA_PAGAMENTO}}), completando a frase
 * "...a ser pago {{FORMA_PAGAMENTO}} pelo CONTRATANTE."
 */
export function buildPaymentDescription(info: PaymentInfo): string {
  const mkt = info.marketplace
    ? MARKETPLACE_LABELS[normalize(info.marketplace)] ?? info.marketplace
    : null;
  const viaLink = mkt
    ? `via link de pagamento pela plataforma ${mkt}`
    : "via link de pagamento";

  const method = info.method ? normalize(info.method).replace(/[^a-z_]/g, "") : "";
  switch (method) {
    case "credit_card":
    case "creditcard":
      return info.installments && info.installments > 1
        ? `${viaLink}, parcelado no cartão de crédito em ${info.installments}x`
        : `${viaLink}, no cartão de crédito em parcela única`;
    case "pix":
      return `${viaLink}, por Pix, em parcela única`;
    case "billet":
    case "boleto":
      return `${viaLink}, por boleto bancário`;
    default:
      return viaLink;
  }
}

/** "3 de julho de 2026" no fuso de Brasília */
export function dataAssinaturaExtenso(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

export interface ContractFillInput {
  customerName: string;
  customerDoc: string; // só dígitos
  amount: number; // valor bruto pago
  platform: string; // plataforma de vendas citada na cláusula 1.1
  payment: PaymentInfo; // forma de pagamento real da cláusula 3.1
  rawContact?: Record<string, unknown>; // contact do webhook (endereço)
  signatureDate?: Date;
}

/** Valores para os 10 placeholders dos templates de contrato */
export function buildTemplateData(input: ContractFillInput): Record<string, string> {
  const liquido = valorLiquido(input.amount);
  return {
    CONTRATANTE_NOME: input.customerName,
    CONTRATANTE_CPF: formatDoc(input.customerDoc),
    CONTRATANTE_ENDERECO: buildAddress(input.rawContact ?? {}),
    PLATAFORMA: input.platform,
    VALOR_BRUTO: formatBRL(input.amount),
    VALOR_BRUTO_EXTENSO: valorPorExtenso(input.amount),
    VALOR_LIQUIDO: formatBRL(liquido),
    VALOR_LIQUIDO_EXTENSO: valorPorExtenso(liquido),
    DATA_ASSINATURA: dataAssinaturaExtenso(input.signatureDate ?? new Date()),
    FORMA_PAGAMENTO: buildPaymentDescription(input.payment),
  };
}
