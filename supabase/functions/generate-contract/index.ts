// Edge function: generate-contract (Etapa 2 do fluxo Guru → Clicksign)
// Preenche o template .docx do plano vendido com os dados do contrato e
// arquiva o documento gerado no Storage (bucket contracts-generated).
//
// Chamada interna (fire-and-forget a partir do guru-webhook) com o service
// role key no Authorization. Idempotente: reprocessar um contrato já gerado
// só regrava o mesmo caminho no Storage.
//
// TODO Etapa 3: ao final, disparar a criação do envelope na Clicksign (sandbox).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { fillDocxTemplate } from "../_shared/docx.ts";
import {
  buildTemplateData,
  type ContractTemplateRow,
  selectTemplate,
} from "../_shared/contract-data.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Endpoint interno: o verify_jwt do gateway aceita qualquer JWT do projeto
  // (inclusive o anon key público), então exigimos o service role key aqui.
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${serviceKey}`) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  let contractId: string | undefined;
  try {
    ({ contract_id: contractId } = await req.json());
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!contractId) {
    return jsonResponse({ error: "contract_id obrigatório" }, 400);
  }

  const fail = async (msg: string) => {
    console.error(`generate-contract[${contractId}]:`, msg);
    await supabase.from("contracts").update({ status: "error", error: msg }).eq("id", contractId);
    return jsonResponse({ generated: false, error: msg }, 200);
  };

  const { data: contract, error: loadErr } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", contractId)
    .maybeSingle();
  if (loadErr) return jsonResponse({ error: loadErr.message }, 500);
  if (!contract) return jsonResponse({ error: "Contrato não encontrado" }, 404);

  if (contract.status === "invalid") {
    return jsonResponse({ generated: false, reason: "contrato marcado como invalid" });
  }
  if (contract.generated_doc_path && contract.status !== "received" && contract.status !== "error") {
    return jsonResponse({ generated: true, duplicate: true, path: contract.generated_doc_path });
  }
  if (typeof contract.amount !== "number" && typeof contract.amount !== "string") {
    return await fail("Contrato sem valor (amount) — não é possível preencher a cláusula 3.1");
  }

  const { data: templates, error: tplErr } = await supabase
    .from("contract_templates")
    .select("key, title, storage_path, match_patterns, default_platform, active")
    .eq("active", true);
  if (tplErr) return jsonResponse({ error: tplErr.message }, 500);

  const template = selectTemplate(
    contract.plan_name ?? "",
    (templates ?? []) as ContractTemplateRow[],
  );
  if (!template) {
    return await fail(`Nenhum template casa com o plano '${contract.plan_name}'`);
  }

  const { data: blob, error: dlErr } = await supabase.storage
    .from("contract-templates")
    .download(template.storage_path);
  if (dlErr || !blob) {
    return await fail(
      `Falha ao baixar template '${template.storage_path}': ${dlErr?.message ?? "vazio"}. ` +
        "Rodou scripts/upload-contract-templates.mjs?",
    );
  }

  try {
    const rawContact =
      (contract.raw_webhook as Record<string, unknown> | null)?.contact as
        | Record<string, unknown>
        | undefined;

    const data = buildTemplateData({
      customerName: contract.customer_name,
      customerDoc: contract.customer_doc,
      amount: Number(contract.amount),
      // plataforma vem do campo "Plataforma" do checkout do Guru; fallback
      // para o default do template ou o termo genérico
      platform: contract.platform ?? template.default_platform ?? "e-commerce",
      payment: {
        method: contract.payment_method ?? null,
        installments: contract.installments ?? null,
        marketplace: contract.marketplace ?? null,
      },
      rawContact,
    });

    const docx = await fillDocxTemplate(await blob.arrayBuffer(), data);

    const path = `${contract.id}/contrato-${template.key}.docx`;
    const { error: upErr } = await supabase.storage
      .from("contracts-generated")
      .upload(path, docx, { contentType: DOCX_MIME, upsert: true });
    if (upErr) return await fail(`Falha ao salvar docx gerado: ${upErr.message}`);

    const { error: updErr } = await supabase
      .from("contracts")
      .update({
        status: "document_generated",
        template_key: template.key,
        generated_doc_path: path,
        error: null,
      })
      .eq("id", contractId);
    if (updErr) return jsonResponse({ error: updErr.message }, 500);

    console.log(`generate-contract[${contractId}]: gerado ${path} (template ${template.key})`);

    // TODO Etapa 3: fetch para create-envelope (Clicksign sandbox) aqui

    return jsonResponse({ generated: true, path, template: template.key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await fail(`Erro ao preencher o template: ${msg}`);
  }
});
