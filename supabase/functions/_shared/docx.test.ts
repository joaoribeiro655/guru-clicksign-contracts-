import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildTemplateData } from "./contract-data";
import { fillDocxTemplate, fillPlaceholders, listPlaceholders } from "./docx";

const TEMPLATES_DIR = path.resolve(__dirname, "../../templates/contracts");

const DATA = buildTemplateData({
  customerName: "Maria da Silva & Filhos",
  customerDoc: "12345678909",
  amount: 20000,
  platform: "Mercado Livre",
  payment: { method: "credit_card", installments: 12, marketplace: "pagarme" },
  rawContact: {
    address: "Rua das Flores",
    address_number: "123",
    address_district: "Centro",
    address_zip_code: "13900-400",
    address_city: "Amparo",
    address_state: "SP",
  },
  signatureDate: new Date("2026-07-03T12:00:00Z"),
});

describe("fillPlaceholders", () => {
  it("substitui e escapa XML", () => {
    const xml = "<w:t>Olá {{CONTRATANTE_NOME}}</w:t>";
    expect(fillPlaceholders(xml, { CONTRATANTE_NOME: "A & B <C>" })).toBe(
      "<w:t>Olá A &amp; B &lt;C&gt;</w:t>",
    );
  });

  it("lança erro se sobrar placeholder sem valor", () => {
    expect(() => fillPlaceholders("<w:t>{{VALOR_BRUTO}}</w:t>", {})).toThrow(/VALOR_BRUTO/);
  });
});

describe("fillDocxTemplate — templates reais", () => {
  it("os 5 templates parametrizados existem no repo", async () => {
    const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith(".docx"));
    expect(files.sort()).toEqual([
      "consultoria-12.docx",
      "consultoria-digital-business-16.docx",
      "consultoria-tracao-15.docx",
      "mentoria-ads-04.docx",
      "mentoria-iniciante-04.docx",
    ]);
  });

  it("preenche cada template sem sobrar placeholder e mantém docx válido", async () => {
    const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith(".docx"));
    for (const file of files) {
      const bytes = await readFile(path.join(TEMPLATES_DIR, file));

      const template = await JSZip.loadAsync(bytes);
      const templateXml = await template.files["word/document.xml"].async("string");
      expect(listPlaceholders(templateXml).sort()).toEqual([
        "CONTRATANTE_CPF", "CONTRATANTE_ENDERECO", "CONTRATANTE_NOME",
        "DATA_ASSINATURA", "FORMA_PAGAMENTO", "PLATAFORMA",
        "VALOR_BRUTO", "VALOR_BRUTO_EXTENSO", "VALOR_LIQUIDO", "VALOR_LIQUIDO_EXTENSO",
      ]);

      const filled = await fillDocxTemplate(bytes, DATA);

      // o resultado continua um zip/docx legível com as partes originais
      const out = await JSZip.loadAsync(filled);
      expect(Object.keys(out.files)).toEqual(expect.arrayContaining([
        "word/document.xml", "[Content_Types].xml",
      ]));

      const xml = await out.files["word/document.xml"].async("string");
      expect(listPlaceholders(xml)).toEqual([]);
      expect(xml).toContain("Maria da Silva &amp; Filhos");
      expect(xml).toContain("123.456.789-09");
      expect(xml).toContain("Rua das Flores, nº 123, Bairro Centro, CEP 13900-400, Amparo/SP");
      expect(xml).toContain("Mercado Livre");
      expect(xml).toContain("vinte mil reais");
      expect(xml).toContain("dezoito mil setecentos e setenta reais");
      expect(xml).toContain("3 de julho de 2026");
      // valores formatados (Intl pode usar NBSP no separador de milhar)
      expect(xml.replace(/ /g, ".")).toContain("20.000,00");
    }
  });

  it("recusa docx sem placeholders (arquivo errado)", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:t>sem placeholders</w:t></w:document>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(fillDocxTemplate(bytes, DATA)).rejects.toThrow(/sem placeholders/i);
  });
});
