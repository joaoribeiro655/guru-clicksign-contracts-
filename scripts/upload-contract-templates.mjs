#!/usr/bin/env node
// Sobe os templates de contrato (supabase/templates/contracts/*.docx) para o
// bucket privado contract-templates do Supabase Storage.
//
// Uso:
//   SUPABASE_URL=https://<project>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/upload-contract-templates.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const dir = path.join(import.meta.dirname, "..", "supabase", "templates", "contracts");
const files = (await readdir(dir)).filter((f) => f.endsWith(".docx"));
if (files.length === 0) {
  console.error(`Nenhum .docx em ${dir}`);
  process.exit(1);
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let failed = false;

for (const file of files) {
  const body = await readFile(path.join(dir, file));
  const res = await fetch(`${url}/storage/v1/object/contract-templates/${file}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": DOCX_MIME,
      "x-upsert": "true",
    },
    body,
  });
  if (res.ok) {
    console.log(`✓ ${file}`);
  } else {
    failed = true;
    console.error(`✗ ${file}: HTTP ${res.status} ${await res.text()}`);
  }
}

process.exit(failed ? 1 : 0);
