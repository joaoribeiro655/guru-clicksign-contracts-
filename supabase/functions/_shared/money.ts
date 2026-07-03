// Formatação monetária pt-BR e valor por extenso para os contratos.
// Módulo puro (sem APIs Deno) — testado via vitest em Node.

/** Percentual de impostos deduzidos em NF (PIS, COFINS, CSLL, IRRF) — cláusula 3.1 */
export const TAX_DEDUCTION = 0.0615;

/** 20000 → "20.000,00" */
export function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Valor líquido após dedução de 6,15% (20000 → 18770) */
export function valorLiquido(bruto: number): number {
  return Math.round(bruto * (1 - TAX_DEDUCTION) * 100) / 100;
}

const UNIDADES = [
  "zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
  "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete",
  "dezoito", "dezenove",
];
const DEZENAS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos",
  "seiscentos", "setecentos", "oitocentos", "novecentos"];

/** 0–999 por extenso */
function grupoPorExtenso(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (c > 0) partes.push(CENTENAS[c]);
  if (resto > 0) {
    if (resto < 20) {
      partes.push(UNIDADES[resto]);
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u > 0 ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]);
    }
  }
  return partes.join(" e ");
}

const ESCALAS: Array<[singular: string, plural: string]> = [
  ["", ""],
  ["mil", "mil"],
  ["milhão", "milhões"],
  ["bilhão", "bilhões"],
];

/** Parte inteira por extenso (até bilhões) */
export function numeroPorExtenso(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "zero";

  const grupos: number[] = [];
  while (n > 0) {
    grupos.push(n % 1000);
    n = Math.floor(n / 1000);
  }

  const partes: string[] = [];
  for (let i = grupos.length - 1; i >= 0; i--) {
    const g = grupos[i];
    if (g === 0) continue;
    const [sing, plur] = ESCALAS[i];
    let texto: string;
    if (i === 1) {
      // "mil", nunca "um mil"
      texto = g === 1 ? "mil" : `${grupoPorExtenso(g)} mil`;
    } else if (i >= 2) {
      texto = `${grupoPorExtenso(g)} ${g === 1 ? sing : plur}`;
    } else {
      texto = grupoPorExtenso(g);
    }
    partes.push(texto);
  }

  // "e" antes do último grupo quando ele é < 100 ou centena exata
  // (vinte mil e quinhentos / dezoito mil setecentos e setenta)
  const ultimo = grupos[0];
  if (partes.length > 1 && ultimo > 0 && (ultimo < 100 || ultimo % 100 === 0)) {
    const fim = partes.pop()!;
    return `${partes.join(" ")} e ${fim}`;
  }
  return partes.join(" ");
}

/** 18770 → "dezoito mil setecentos e setenta reais"; 1297.5 → "... reais e cinquenta centavos" */
export function valorPorExtenso(value: number): string {
  const centavosTotal = Math.round(value * 100);
  const reais = Math.floor(centavosTotal / 100);
  const centavos = centavosTotal % 100;

  const partes: string[] = [];
  if (reais > 0 || centavos === 0) {
    const extenso = numeroPorExtenso(reais);
    const moeda = reais === 1 ? "real" : "reais";
    // "um milhão DE reais"
    const de = reais > 0 && reais % 1_000_000 === 0 ? " de" : "";
    partes.push(`${extenso}${de} ${moeda}`);
  }
  if (centavos > 0) {
    partes.push(`${numeroPorExtenso(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  }
  return partes.join(" e ");
}
