// Preenchimento de templates .docx por substituição de placeholders {{CHAVE}}.
//
// Os templates em supabase/templates/contracts/ foram pré-processados
// (scripts/parametrize_contract_templates.py) para garantir que cada
// placeholder esteja inteiro dentro de um único <w:t> — por isso a
// substituição de string simples no XML é segura aqui.
//
// jszip via esm.sh roda em Deno (edge function); no vitest o alias em
// vitest.config.ts resolve a mesma URL para o pacote npm local.
import JSZip from "https://esm.sh/jszip@3.10.1";

const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Placeholders presentes em um XML de documento */
export function listPlaceholders(xml: string): string[] {
  return [...new Set([...xml.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

/**
 * Substitui {{CHAVE}} pelos valores (escapados para XML).
 * Lança erro se sobrar placeholder sem valor — um contrato pela metade
 * não pode seguir para assinatura.
 */
export function fillPlaceholders(xml: string, data: Record<string, string>): string {
  const filled = xml.replace(PLACEHOLDER_RE, (raw, key: string) => {
    const value = data[key];
    return value === undefined ? raw : escapeXml(value);
  });
  const leftover = listPlaceholders(filled);
  if (leftover.length > 0) {
    throw new Error(`Placeholders sem valor: ${leftover.join(", ")}`);
  }
  return filled;
}

/** Partes do docx que podem conter texto do contrato */
const FILLABLE = /^word\/(document|header\d*|footer\d*)\.xml$/;

/** Preenche um .docx (bytes) e devolve o novo .docx */
export async function fillDocxTemplate(
  templateBytes: Uint8Array | ArrayBuffer,
  data: Record<string, string>,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(templateBytes);
  let touched = 0;

  for (const name of Object.keys(zip.files)) {
    if (!FILLABLE.test(name)) continue;
    const xml = await zip.files[name].async("string");
    if (listPlaceholders(xml).length === 0) continue;
    zip.file(name, fillPlaceholders(xml, data));
    touched++;
  }

  if (touched === 0) {
    throw new Error("Template sem placeholders — arquivo errado no Storage?");
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
