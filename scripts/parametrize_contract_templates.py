#!/usr/bin/env python3
"""Converte os contratos .docx originais em templates parametrizados.

Troca lacunas (____) e valores hardcoded por placeholders {{CHAVE}} no
word/document.xml, garantindo que cada placeholder fique inteiro dentro de um
único <w:t> — condição para o preenchimento em runtime por substituição de
string (supabase/functions/_shared/docx.ts).

O texto de um parágrafo do Word costuma vir fatiado em vários runs (<w:r>),
então cada padrão é procurado no texto CONCATENADO do parágrafo e a
substituição é recomposta run a run, preservando a formatação vizinha.

Uso: python3 scripts/parametrize_contract_templates.py <dir-com-docx-originais>
Saída: supabase/templates/contracts/<slug>.docx
"""
import re
import sys
import zipfile
from pathlib import Path

# prefixo do arquivo original → slug do template
SLUGS = {
    "e28900ec": "mentoria-iniciante-04",
    "6ff0d8ec": "mentoria-ads-04",
    "243ee410": "consultoria-12",
    "55af6a2e": "consultoria-tracao-15",
    "0a38f4c1": "consultoria-digital-business-16",
}

# (padrão sobre o texto concatenado do parágrafo, substituição)
# Aplicados em ordem, repetidamente, até nenhum casar.
PATTERNS = [
    # nome do contratante: "CONTRATANTE: ____________, inscrito(a) no CPF"
    (re.compile(r"_{10,}(?=, inscrito)"), "{{CONTRATANTE_NOME}}"),
    # CPF: "no CPF sob o nº_______________,"
    (re.compile(r"(CPF sob o nº\s*)_{5,}"), r"\1{{CONTRATANTE_CPF}}"),
    # endereço completo vira um placeholder único
    (re.compile(r"Rua _{3,}, nº\s*_{2,}, Bairro _{3,}, CEP _{3,}"), "{{CONTRATANTE_ENDERECO}}"),
    # plataforma: "plataforma (______)" ou "plataforma _________"
    (re.compile(r"plataforma \(_{3,}\)"), "plataforma {{PLATAFORMA}}"),
    (re.compile(r"plataforma _{3,}"), "plataforma {{PLATAFORMA}}"),
    # valores hardcoded dos instrumentos (bruto e líquido com 6,15% de dedução)
    (re.compile(r"R\$\s*20\.000,00 \(vinte mil reais\)"), "R$ {{VALOR_BRUTO}} ({{VALOR_BRUTO_EXTENSO}})"),
    (re.compile(r"R\$\s*18\.770,00 \(dezoito mil e setecentos e setenta reais\)"),
     "R$ {{VALOR_LIQUIDO}} ({{VALOR_LIQUIDO_EXTENSO}})"),
    # valores em branco dos contratos de consultoria: 1ª ocorrência = bruto,
    # 2ª = líquido (o loop reaplica o padrão e o líquido vem sempre depois
    # do bruto na cláusula 3.1)
    (re.compile(r"R\$\s*_{5,}\s*\(_{5,}\)(?=.*valor líquido)"), "R$ {{VALOR_BRUTO}} ({{VALOR_BRUTO_EXTENSO}})"),
    (re.compile(r"R\$\s*_{5,}\s*\(_{5,}\)"), "R$ {{VALOR_LIQUIDO}} ({{VALOR_LIQUIDO_EXTENSO}})"),
    # data por extenso: "Amparo, 2_ de ___________ de 202_"
    (re.compile(r"Amparo, 2_ de _{3,} de 202_"), "Amparo, {{DATA_ASSINATURA}}"),
    # forma de pagamento (cláusula 3.1): o texto fixo "Pagar.me em 12x" vira
    # variável e passa a refletir a compra real (método/parcelas do Guru)
    (re.compile(r"via link de pagamento pela plataforma Pagar\.me, parcelado no cartão em 12x"),
     "{{FORMA_PAGAMENTO}}"),
]

EXPECTED = [
    "{{CONTRATANTE_NOME}}", "{{CONTRATANTE_CPF}}", "{{CONTRATANTE_ENDERECO}}",
    "{{PLATAFORMA}}", "{{VALOR_BRUTO}}", "{{VALOR_BRUTO_EXTENSO}}",
    "{{VALOR_LIQUIDO}}", "{{VALOR_LIQUIDO_EXTENSO}}", "{{DATA_ASSINATURA}}",
    "{{FORMA_PAGAMENTO}}",
]

WT_RE = re.compile(r"(<w:t(?: [^>]*)?>)(.*?)(</w:t>)", re.S)
P_RE = re.compile(r"<w:p[ >].*?</w:p>", re.S)


def replace_in_paragraph(par_xml: str) -> str:
    """Aplica todos os PATTERNS ao texto concatenado do parágrafo."""
    changed = True
    while changed:
        changed = False
        nodes = list(WT_RE.finditer(par_xml))
        if not nodes:
            return par_xml
        joined = "".join(m.group(2) for m in nodes)
        for pat, repl in PATTERNS:
            m = pat.search(joined)
            if not m:
                continue
            # O primeiro run que toca o trecho casado recebe o span inteiro
            # já substituído; os demais runs do span ficam vazios. Runs fora
            # do span não mudam (preserva a formatação vizinha).
            out2, pos = [], 0
            for node in nodes:
                start, end = pos, pos + len(node.group(2))
                pos = end
                overlaps = not (end <= m.start() or start >= m.end())
                out2.append([node, start, end, overlaps])
            hits = [o for o in out2 if o[3]]
            span_start, span_end = hits[0][1], hits[-1][2]
            replaced_span = (
                joined[span_start : m.start()]
                + m.expand(repl)
                + joined[m.end() : span_end]
            )
            pieces = []
            for node, start, end, overlaps in out2:
                if not overlaps:
                    pieces.append(node.group(2))
                elif start == span_start:
                    pieces.append(replaced_span)
                else:
                    pieces.append("")
            # reconstrói o XML do parágrafo com os novos textos
            new_xml, cursor, idx = [], 0, 0
            for node in nodes:
                new_xml.append(par_xml[cursor : node.start()])
                open_tag = node.group(1)
                text = pieces[idx]
                if text != text.strip() and 'xml:space="preserve"' not in open_tag:
                    open_tag = open_tag[:-1] + ' xml:space="preserve">'
                new_xml.append(open_tag + text + node.group(3))
                cursor = node.end()
                idx += 1
            new_xml.append(par_xml[cursor:])
            par_xml = "".join(new_xml)
            changed = True
            break  # reanalisa o parágrafo do zero
    return par_xml


def main() -> None:
    src = Path(sys.argv[1])
    out_dir = Path(__file__).resolve().parent.parent / "supabase" / "templates" / "contracts"
    out_dir.mkdir(parents=True, exist_ok=True)

    for f in sorted(src.glob("*.docx")):
        slug = next((s for p, s in SLUGS.items() if f.name.startswith(p)), None)
        if not slug:
            print(f"AVISO: {f.name} sem slug mapeado, pulando")
            continue
        with zipfile.ZipFile(f) as z:
            names = z.namelist()
            contents = {n: z.read(n) for n in names}
        xml = contents["word/document.xml"].decode("utf-8")
        xml = P_RE.sub(lambda m: replace_in_paragraph(m.group(0)), xml)
        contents["word/document.xml"] = xml.encode("utf-8")

        target = out_dir / f"{slug}.docx"
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
            for n in names:
                z.writestr(n, contents[n])

        found = [p for p in EXPECTED if p in xml]
        missing = [p for p in EXPECTED if p not in xml]
        print(f"{f.name[:11]} → {target.name}: {len(found)}/{len(EXPECTED)} placeholders"
              + (f"  FALTANDO: {missing}" if missing else ""))


if __name__ == "__main__":
    main()
