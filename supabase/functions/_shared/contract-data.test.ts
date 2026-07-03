import { describe, expect, it } from "vitest";
import {
  buildAddress,
  buildPaymentDescription,
  buildTemplateData,
  type ContractTemplateRow,
  dataAssinaturaExtenso,
  formatDoc,
  selectTemplate,
} from "./contract-data";

const TEMPLATES: ContractTemplateRow[] = [
  { key: "mentoria-iniciante-04", title: "", storage_path: "mentoria-iniciante-04.docx", match_patterns: ["mentoria iniciante"], default_platform: null, active: true },
  { key: "mentoria-ads-04", title: "", storage_path: "mentoria-ads-04.docx", match_patterns: ["mentoria ads"], default_platform: null, active: true },
  { key: "consultoria-12", title: "", storage_path: "consultoria-12.docx", match_patterns: ["consultoria 12", "12 encontros"], default_platform: null, active: true },
  { key: "consultoria-tracao-15", title: "", storage_path: "consultoria-tracao-15.docx", match_patterns: ["tracao 15", "15 encontros", "consultoria 15"], default_platform: null, active: true },
  { key: "consultoria-digital-business-16", title: "", storage_path: "consultoria-digital-business-16.docx", match_patterns: ["digital business", "16 encontros", "consultoria 16"], default_platform: null, active: true },
];

describe("selectTemplate", () => {
  it.each([
    ["Mentoria Iniciante — 04 Encontros", "mentoria-iniciante-04"],
    ["MENTORIA ADS", "mentoria-ads-04"],
    ["Consultoria 12 encontros", "consultoria-12"],
    ["Programa Tração 15", "consultoria-tracao-15"],
    ["Consultoria Digital Business (16 encontros)", "consultoria-digital-business-16"],
  ])("'%s' → %s", (plan, key) => {
    expect(selectTemplate(plan, TEMPLATES)?.key).toBe(key);
  });

  it("acentos não atrapalham (Tração vs tracao)", () => {
    expect(selectTemplate("TRAÇÃO 15 — oferta especial", TEMPLATES)?.key).toBe("consultoria-tracao-15");
  });

  it("padrão mais longo vence quando o plano casa com mais de um", () => {
    // "consultoria digital business 16 encontros" casa 'digital business' (16)
    // e '16 encontros' (12) do mesmo template, e nada dos outros
    expect(selectTemplate("Consultoria Digital Business 16 encontros", TEMPLATES)?.key)
      .toBe("consultoria-digital-business-16");
  });

  it("sem match → null", () => {
    expect(selectTemplate("Produto Avulso", TEMPLATES)).toBeNull();
  });

  it("ignora templates inativos", () => {
    const inativos = TEMPLATES.map((t) => ({ ...t, active: false }));
    expect(selectTemplate("Mentoria ADS", inativos)).toBeNull();
  });
});

describe("formatDoc", () => {
  it("CPF", () => expect(formatDoc("12345678909")).toBe("123.456.789-09"));
  it("CNPJ", () => expect(formatDoc("12345678000195")).toBe("12.345.678/0001-95"));
  it("tamanho inesperado passa direto", () => expect(formatDoc("123")).toBe("123"));
});

describe("buildAddress", () => {
  it("endereço completo do contact do Guru", () => {
    expect(
      buildAddress({
        address: "Rua das Flores",
        address_number: "123",
        address_district: "Centro",
        address_zip_code: "13900-400",
        address_city: "Amparo",
        address_state: "SP",
      }),
    ).toBe("Rua das Flores, nº 123, Bairro Centro, CEP 13900-400, Amparo/SP");
  });

  it("parcial: só o que existe", () => {
    expect(buildAddress({ address_city: "Amparo", address_state: "SP" })).toBe("Amparo/SP");
  });

  it("vazio → 'endereço não informado'", () => {
    expect(buildAddress({})).toBe("endereço não informado");
  });
});

describe("dataAssinaturaExtenso", () => {
  it("formata em pt-BR no fuso de Brasília", () => {
    // 2026-07-03T02:00Z ainda é 2 de julho em Brasília (UTC-3)
    expect(dataAssinaturaExtenso(new Date("2026-07-03T02:00:00Z"))).toBe("2 de julho de 2026");
    expect(dataAssinaturaExtenso(new Date("2026-07-03T12:00:00Z"))).toBe("3 de julho de 2026");
  });
});

describe("buildPaymentDescription", () => {
  it("cartão parcelado reproduz o texto original quando é Pagar.me 12x", () => {
    expect(
      buildPaymentDescription({ method: "credit_card", installments: 12, marketplace: "pagarme" }),
    ).toBe("via link de pagamento pela plataforma Pagar.me, parcelado no cartão de crédito em 12x");
  });

  it("cartão à vista", () => {
    expect(
      buildPaymentDescription({ method: "credit_card", installments: 1, marketplace: "pagarme" }),
    ).toBe("via link de pagamento pela plataforma Pagar.me, no cartão de crédito em parcela única");
  });

  it("pix", () => {
    expect(buildPaymentDescription({ method: "pix", installments: null, marketplace: "pagarme" }))
      .toBe("via link de pagamento pela plataforma Pagar.me, por Pix, em parcela única");
  });

  it("boleto", () => {
    expect(buildPaymentDescription({ method: "billet", installments: null, marketplace: "eduzz" }))
      .toBe("via link de pagamento pela plataforma Eduzz, por boleto bancário");
  });

  it("método desconhecido e sem marketplace → texto genérico seguro", () => {
    expect(buildPaymentDescription({ method: null, installments: null, marketplace: null }))
      .toBe("via link de pagamento");
  });

  it("marketplace fora do mapa passa como veio", () => {
    expect(buildPaymentDescription({ method: "pix", installments: null, marketplace: "PagBank" }))
      .toBe("via link de pagamento pela plataforma PagBank, por Pix, em parcela única");
  });
});

describe("buildTemplateData", () => {
  it("preenche os 10 placeholders dos templates", () => {
    const data = buildTemplateData({
      customerName: "Maria da Silva",
      customerDoc: "12345678909",
      amount: 20000,
      platform: "Mercado Livre",
      payment: { method: "pix", installments: null, marketplace: "pagarme" },
      rawContact: { address_city: "Amparo", address_state: "SP" },
      signatureDate: new Date("2026-07-03T12:00:00Z"),
    });
    expect(data).toEqual({
      CONTRATANTE_NOME: "Maria da Silva",
      CONTRATANTE_CPF: "123.456.789-09",
      CONTRATANTE_ENDERECO: "Amparo/SP",
      PLATAFORMA: "Mercado Livre",
      VALOR_BRUTO: "20.000,00",
      VALOR_BRUTO_EXTENSO: "vinte mil reais",
      VALOR_LIQUIDO: "18.770,00",
      VALOR_LIQUIDO_EXTENSO: "dezoito mil setecentos e setenta reais",
      DATA_ASSINATURA: "3 de julho de 2026",
      FORMA_PAGAMENTO: "via link de pagamento pela plataforma Pagar.me, por Pix, em parcela única",
    });
  });
});
