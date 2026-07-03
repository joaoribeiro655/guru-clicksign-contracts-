// Edge function: create-envelope (Etapa 3 do fluxo Guru → Clicksign)
// Cria o envelope na Clicksign a partir do docx gerado na Etapa 2:
// draft → documento → signatário cliente (widget, grupo 1) → signatário
// Icomm (auto_signature, grupo 2) → requisitos → running.
//
// Chamada interna (fire-and-forget a partir do generate-contract) com o
// service role key no Authorization. Idempotente: contrato que já tem
// envelope na Clicksign responde duplicate sem criar outro.
//
// Ambiente: CLICKSIGN_BASE_URL deve apontar para o SANDBOX enquanto o fluxo
// não for homologado (https://sandbox.clicksign.com/api/v3).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  activateEnvelope,
  createEnvelopeResources,
  docxToContentBase64,
  type ClicksignConfig,
} from "../_shared/clicksign.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

  const apiToken = Deno.env.get("CLICKSIGN_API_TOKEN");
  const baseUrl = Deno.env.get("CLICKSIGN_BASE_URL");
  const icomm = {
    name: Deno.env.get("ICOMM_SIGNER_NAME") ?? "",
    email: Deno.env.get("ICOMM_SIGNER_EMAIL") ?? "",
    birthday: Deno.env.get("ICOMM_SIGNER_BIRTHDAY") ?? "",
    documentation: Deno.env.get("ICOMM_SIGNER_DOCUMENTATION") ?? "",
  };
  if (!apiToken || !baseUrl) {
    return jsonResponse(
      { error: "CLICKSIGN_API_TOKEN/CLICKSIGN_BASE_URL não configurados (supabase secrets set ...)" },
      500,
    );
  }
  if (!icomm.name || !icomm.email || !icomm.birthday || !icomm.documentation) {
    return jsonResponse(
      {
        error:
          "Signatário Icomm incompleto — configure ICOMM_SIGNER_NAME/EMAIL/BIRTHDAY/DOCUMENTATION " +
          "com os dados EXATOS do Termo de Assinatura Automática",
      },
      500,
    );
  }
  const clicksign: ClicksignConfig = { baseUrl, apiToken };
  // "email" até a liberação do widget embedded; depois "embedded_signature"
  const clientAuth = Deno.env.get("CLICKSIGN_CLIENT_AUTH") ?? "email";

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
    console.error(`create-envelope[${contractId}]:`, msg);
    await supabase.from("contracts").update({ status: "error", error: msg }).eq("id", contractId);
    return jsonResponse({ created: false, error: msg }, 200);
  };

  const { data: contract, error: loadErr } = await supabase
    .from("contracts")
    .select("*")
    .eq("id", contractId)
    .maybeSingle();
  if (loadErr) return jsonResponse({ error: loadErr.message }, 500);
  if (!contract) return jsonResponse({ error: "Contrato não encontrado" }, 404);

  // Idempotência: envelope já criado (retry do trigger, reprocessamento
  // manual). Se a criação concluiu mas a ativação falhou, retoma daqui.
  if (contract.clicksign_envelope_id) {
    if (contract.status === "envelope_created" || contract.status === "error") {
      try {
        await activateEnvelope(clicksign, contract.clicksign_envelope_id);
        await supabase
          .from("contracts")
          .update({ status: "running", error: null })
          .eq("id", contractId);
      } catch (err) {
        return await fail(
          `Erro ao ativar envelope existente: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return jsonResponse({
      created: true,
      duplicate: true,
      envelope_id: contract.clicksign_envelope_id,
    });
  }
  if (!contract.generated_doc_path || contract.status === "invalid") {
    return jsonResponse({
      created: false,
      reason: `contrato sem documento gerado (status ${contract.status})`,
    });
  }
  if (!contract.customer_name || !contract.customer_email) {
    return await fail("Contrato sem nome/e-mail do cliente — signatário impossível");
  }

  const { data: blob, error: dlErr } = await supabase.storage
    .from("contracts-generated")
    .download(contract.generated_doc_path);
  if (dlErr || !blob) {
    return await fail(
      `Falha ao baixar docx gerado '${contract.generated_doc_path}': ${dlErr?.message ?? "vazio"}`,
    );
  }

  try {
    const contentBase64 = docxToContentBase64(new Uint8Array(await blob.arrayBuffer()));
    const filename = contract.generated_doc_path.split("/").pop() ?? "contrato.docx";

    const resources = await createEnvelopeResources(clicksign, {
      envelopeName: `Contrato ${contract.plan_name ?? contract.template_key ?? ""} — ${contract.customer_name}`.trim(),
      docxFilename: filename,
      contentBase64,
      client: {
        name: contract.customer_name,
        email: contract.customer_email,
        phoneNumber: contract.customer_phone ?? null,
        documentation: contract.customer_doc ?? null,
        docType: contract.doc_type ?? null,
      },
      clientAuth,
      icomm,
    });

    // Persiste os ids ANTES de ativar: se a ativação falhar, o contrato fica
    // em envelope_created com tudo salvo para retomada/diagnóstico.
    const { error: saveErr } = await supabase
      .from("contracts")
      .update({
        status: "envelope_created",
        clicksign_envelope_id: resources.envelopeId,
        clicksign_document_id: resources.documentId,
        clicksign_signer_id: resources.clientSignerId,
        clicksign_signer_key: resources.clientSignerKey,
        clicksign_icomm_signer_id: resources.icommSignerId,
        error: null,
      })
      .eq("id", contractId);
    if (saveErr) return jsonResponse({ error: saveErr.message }, 500);

    await activateEnvelope(clicksign, resources.envelopeId);

    const { error: runErr } = await supabase
      .from("contracts")
      .update({ status: "running" })
      .eq("id", contractId);
    if (runErr) return jsonResponse({ error: runErr.message }, 500);

    console.log(
      `create-envelope[${contractId}]: envelope ${resources.envelopeId} running (documento ${resources.documentId})`,
    );

    // TODO Etapa 4: expor clicksign_signer_key para o widget na página
    // TODO Etapa 5: webhook de close → arquivar PDF assinado, WhatsApp, CRM

    return jsonResponse({
      created: true,
      envelope_id: resources.envelopeId,
      signer_key: resources.clientSignerKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await fail(`Erro ao criar envelope na Clicksign: ${msg}`);
  }
});
