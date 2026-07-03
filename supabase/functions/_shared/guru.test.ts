import { describe, expect, it } from "vitest";
import {
  extractSale,
  isValidEmail,
  onlyDigits,
  processGuruWebhook,
  timingSafeEqual,
} from "./guru";

const GURU_TOKEN = "tok-guru-secreto-123";

// Payload no formato do webhook de transações do Guru
// (https://docs.digitalmanager.guru/developers/webhook-para-transacoes)
function approvedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_token: GURU_TOKEN,
    webhook_type: "transaction",
    id: "b1e4f6a2-1111-2222-3333-444455556666",
    status: "approved",
    contact: {
      id: "c-1",
      name: "Maria da Silva",
      doc: "123.456.789-09",
      email: "maria@example.com",
      phone_local_code: "11",
      phone_number: "99999-8888",
    },
    payment: {
      method: "credit_card",
      currency: "BRL",
      total: 297.0,
      installments: 12,
      marketplace_id: "PAY-abc",
      marketplace_name: "pagarme",
    },
    extras: [{ name: "Plataforma", value: "Shopee" }],
    product: {
      id: "p-1",
      name: "Plano Icomm Pro",
      marketplace_name: "pagarme",
      offer: { id: "o-1", name: "Oferta Anual" },
    },
    items: [{ name: "Plano Icomm Pro", total_value: 297.0 }],
    ...overrides,
  };
}

describe("timingSafeEqual", () => {
  it("aceita strings iguais e rejeita diferentes", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("helpers", () => {
  it("onlyDigits limpa formatação de CPF", () => {
    expect(onlyDigits("123.456.789-09")).toBe("12345678909");
  });
  it("isValidEmail", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("sem-arroba")).toBe(false);
  });
});

describe("processGuruWebhook — autenticação", () => {
  it("rejeita api_token errado", () => {
    const r = processGuruWebhook(approvedPayload({ api_token: "errado" }), GURU_TOKEN);
    expect(r.kind).toBe("unauthorized");
  });

  it("rejeita api_token ausente", () => {
    const p = approvedPayload();
    delete p.api_token;
    expect(processGuruWebhook(p, GURU_TOKEN).kind).toBe("unauthorized");
  });

  it("rejeita quando o token esperado não está configurado (nunca aceita por engano)", () => {
    expect(processGuruWebhook(approvedPayload(), "").kind).toBe("unauthorized");
  });

  it("rejeita corpo não-objeto sem vazar autenticação", () => {
    expect(processGuruWebhook("string", GURU_TOKEN).kind).toBe("ignored");
    expect(processGuruWebhook(null, GURU_TOKEN).kind).toBe("ignored");
    expect(processGuruWebhook([1, 2], GURU_TOKEN).kind).toBe("ignored");
  });
});

describe("processGuruWebhook — filtro de status", () => {
  it.each(["waiting_payment", "refunded", "canceled", "chargeback", "abandoned", ""])(
    "ignora status '%s'",
    (status) => {
      const r = processGuruWebhook(approvedPayload({ status }), GURU_TOKEN);
      expect(r.kind).toBe("ignored");
    },
  );

  it("aceita 'approved' independente de caixa", () => {
    expect(processGuruWebhook(approvedPayload({ status: "APPROVED" }), GURU_TOKEN).kind).toBe(
      "accepted",
    );
  });
});

describe("processGuruWebhook — venda aprovada válida", () => {
  it("extrai todos os dados da venda", () => {
    const r = processGuruWebhook(approvedPayload(), GURU_TOKEN);
    expect(r.kind).toBe("accepted");
    if (r.kind !== "accepted") return;
    expect(r.sale).toMatchObject({
      transactionId: "b1e4f6a2-1111-2222-3333-444455556666",
      customerName: "Maria da Silva",
      customerDoc: "12345678909",
      docType: "cpf",
      customerEmail: "maria@example.com",
      customerPhone: "11999998888",
      amount: 297,
      planName: "Plano Icomm Pro — Oferta Anual",
      marketplace: "pagarme",
      platform: "Shopee",
      paymentMethod: "credit_card",
      installments: 12,
      status: "approved",
    });
  });

  it("aceita CNPJ no doc", () => {
    const p = approvedPayload();
    (p.contact as Record<string, unknown>).doc = "12.345.678/0001-95";
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind).toBe("accepted");
    if (r.kind !== "accepted") return;
    expect(r.sale.customerDoc).toBe("12345678000195");
    expect(r.sale.docType).toBe("cnpj");
  });

  it("usa fallbacks quando payment.total falta (valor como string com vírgula)", () => {
    const p = approvedPayload({ payment: { marketplace_name: "eduzz", total: "1.297,50" } });
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind).toBe("accepted");
    if (r.kind !== "accepted") return;
    expect(r.sale.amount).toBe(1297.5);
    expect(r.sale.marketplace).toBe("eduzz");
  });

  it("plano sem oferta usa só o nome do produto", () => {
    const p = approvedPayload();
    (p.product as Record<string, unknown>).offer = undefined;
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind).toBe("accepted");
    if (r.kind !== "accepted") return;
    expect(r.sale.planName).toBe("Plano Icomm Pro");
  });
});

describe("processGuruWebhook — payload aprovado incompleto", () => {
  it("lista os campos obrigatórios ausentes", () => {
    const r = processGuruWebhook(
      approvedPayload({ contact: { name: "Maria" }, product: {}, items: [] }),
      GURU_TOKEN,
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.missing).toContain("contact.doc (CPF/CNPJ)");
    expect(r.missing).toContain("contact.email");
    expect(r.missing).toContain("product.name");
  });

  it("doc com tamanho errado é inválido", () => {
    const p = approvedPayload();
    (p.contact as Record<string, unknown>).doc = "1234";
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind).toBe("invalid");
  });
});

describe("findPlatformField", () => {
  it("acha campo customizado {name, value} em qualquer nível", () => {
    const p = approvedPayload();
    expect(processGuruWebhook(p, GURU_TOKEN)).toMatchObject({
      sale: { platform: "Shopee" },
    });
  });

  it("acha chave direta 'plataforma' (com ou sem acento/caixa)", () => {
    const p = approvedPayload({ extras: undefined, checkout: { Plataforma: "Mercado Livre" } });
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind === "accepted" && r.sale.platform).toBe("Mercado Livre");
  });

  it("aceita formato {label, answer}", () => {
    const p = approvedPayload({
      extras: undefined,
      custom_fields: [{ label: "PLATAFORMA", answer: "Amazon" }],
    });
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind === "accepted" && r.sale.platform).toBe("Amazon");
  });

  it("sem campo → null (venda continua aceita)", () => {
    const p = approvedPayload({ extras: undefined });
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind).toBe("accepted");
    expect(r.kind === "accepted" && r.sale.platform).toBeNull();
  });
});

describe("extractSale — pagamento", () => {
  it("parcelas em payment.credit_card.installments como fallback", () => {
    const p = approvedPayload({
      payment: { method: "credit_card", total: 100, credit_card: { installments: 6 } },
    });
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind === "accepted" && r.sale.installments).toBe(6);
  });

  it("pix sem parcelas", () => {
    const p = approvedPayload({ payment: { method: "pix", total: 100 } });
    const r = processGuruWebhook(p, GURU_TOKEN);
    expect(r.kind === "accepted" && r.sale.paymentMethod).toBe("pix");
    expect(r.kind === "accepted" && r.sale.installments).toBeNull();
  });
});

describe("extractSale — tolerância a variações", () => {
  it("aceita transaction_id como sinônimo de id", () => {
    const p = approvedPayload({ id: undefined, transaction_id: "t-99" });
    const { sale, missing } = extractSale(p);
    expect(missing).toHaveLength(0);
    expect(sale.transactionId).toBe("t-99");
  });

  it("email inválido conta como ausente", () => {
    const p = approvedPayload();
    (p.contact as Record<string, unknown>).email = "não-é-email";
    const { missing } = extractSale(p);
    expect(missing).toContain("contact.email");
  });

  it("telefone é opcional", () => {
    const p = approvedPayload();
    p.contact = { name: "M", doc: "12345678909", email: "m@x.co" };
    const { sale, missing } = extractSale(p);
    expect(missing).toHaveLength(0);
    expect(sale.customerPhone).toBeNull();
  });
});
