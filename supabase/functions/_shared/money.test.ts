import { describe, expect, it } from "vitest";
import { formatBRL, numeroPorExtenso, valorLiquido, valorPorExtenso } from "./money";

describe("formatBRL", () => {
  it.each([
    [20000, "20.000,00"],
    [18770, "18.770,00"],
    [297.5, "297,50"],
    [1297.5, "1.297,50"],
    [0.99, "0,99"],
  ])("%d → %s", (n, expected) => {
    // Intl usa NBSP em alguns ambientes; normaliza para comparar
    expect(formatBRL(n).replace(/ /g, " ")).toBe(expected);
  });
});

describe("valorLiquido (dedução de 6,15%)", () => {
  it("bate com o exemplo dos contratos: 20.000 → 18.770", () => {
    expect(valorLiquido(20000)).toBe(18770);
  });
  it("arredonda para 2 casas", () => {
    expect(valorLiquido(297)).toBe(278.73); // 297 * 0.9385 = 278.7345
  });
});

describe("numeroPorExtenso", () => {
  it.each([
    [0, "zero"],
    [1, "um"],
    [15, "quinze"],
    [21, "vinte e um"],
    [100, "cem"],
    [101, "cento e um"],
    [770, "setecentos e setenta"],
    [1000, "mil"],
    [1100, "mil e cem"],
    [1297, "mil duzentos e noventa e sete"],
    [18770, "dezoito mil setecentos e setenta"],
    [20000, "vinte mil"],
    [20500, "vinte mil e quinhentos"],
    [1000000, "um milhão"],
    [2350000, "dois milhões trezentos e cinquenta mil"],
  ])("%d → %s", (n, expected) => {
    expect(numeroPorExtenso(n)).toBe(expected);
  });
});

describe("valorPorExtenso", () => {
  it.each([
    [20000, "vinte mil reais"],
    [18770, "dezoito mil setecentos e setenta reais"],
    [1, "um real"],
    [0.5, "cinquenta centavos"],
    [0.01, "um centavo"],
    [1297.5, "mil duzentos e noventa e sete reais e cinquenta centavos"],
    [1000000, "um milhão de reais"],
    [0, "zero reais"],
  ])("%d → %s", (n, expected) => {
    expect(valorPorExtenso(n)).toBe(expected);
  });
});
