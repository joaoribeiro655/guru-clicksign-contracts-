// Edge function: guru-webhook (Etapa 1 do fluxo Guru → Clicksign)
// Recebe o webhook de transações do Digital Manager Guru, valida o api_token,
// filtra vendas aprovadas e registra o contrato pendente na tabela `contracts`.
//
// Etapas seguintes (disparadas a partir daqui quando implementadas):
//   Etapa 2 — gerar o PDF do contrato a partir do template
//   Etapa 3 — criar/ativar o envelope na Clicksign (sandbox primeiro)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { processGuruWebhook } from "../_shared/guru.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const expectedToken = Deno.env.get("GURU_API_TOKEN");
  if (!expectedToken) {
    console.error("GURU_API_TOKEN não configurado (supabase secrets set GURU_API_TOKEN=...)");
    // 500 sem corpo detalhado: o Guru vai reenviar quando o secret existir
    return jsonResponse({ error: "Webhook not configured" }, 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const result = processGuruWebhook(body, expectedToken);

  if (result.kind === "unauthorized") {
    console.warn("guru-webhook: api_token inválido");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Daqui pra baixo sempre respondemos 200: o Guru reenvia até receber 200,
  // e reenviar um payload que decidimos não processar só gera ruído.
  if (result.kind === "ignored") {
    console.log(`guru-webhook: ignorado (${result.reason})`);
    return jsonResponse({ received: true, processed: false, reason: result.reason });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (result.kind === "invalid") {
    // Venda aprovada mas sem dados suficientes pro contrato: registra pra
    // triagem manual e devolve 200 (retry do Guru traria o mesmo payload).
    console.error("guru-webhook: payload aprovado inválido:", result.missing.join(", "));
    await supabase.from("contracts").insert({
      guru_transaction_id: (body as Record<string, unknown>)?.id ?? crypto.randomUUID(),
      status: "invalid",
      error: `Campos ausentes: ${result.missing.join(", ")}`,
      raw_webhook: body,
    });
    return jsonResponse({ received: true, processed: false, missing: result.missing });
  }

  const { sale } = result;

  // Idempotência: o Guru reenvia webhooks; a unique em guru_transaction_id
  // garante um contrato por transação.
  const { data: contract, error } = await supabase
    .from("contracts")
    .upsert(
      {
        guru_transaction_id: sale.transactionId,
        customer_name: sale.customerName,
        customer_doc: sale.customerDoc,
        doc_type: sale.docType,
        customer_email: sale.customerEmail,
        customer_phone: sale.customerPhone,
        amount: sale.amount,
        plan_name: sale.planName,
        marketplace: sale.marketplace,
        platform: sale.platform,
        payment_method: sale.paymentMethod,
        installments: sale.installments,
        status: "received",
        error: null,
        raw_webhook: body,
      },
      { onConflict: "guru_transaction_id", ignoreDuplicates: true },
    )
    .select("id, status")
    .maybeSingle();

  if (error) {
    console.error("guru-webhook: erro ao gravar contrato:", error.message);
    // 500 → o Guru reenvia; como o upsert é idempotente, retry é seguro
    return jsonResponse({ error: "Storage error" }, 500);
  }

  const isNew = contract !== null; // null = já existia (ignoreDuplicates)
  console.log(
    `guru-webhook: venda aprovada ${sale.transactionId} (${sale.customerEmail})`,
    isNew ? "novo contrato" : "duplicado, já registrado",
  );

  // Etapa 2: dispara a geração do documento (fire-and-forget; a função é
  // idempotente). Para duplicados, retenta apenas se a geração anterior
  // não concluiu (received/error).
  let contractId = contract?.id as string | null;
  if (!contractId) {
    const { data: existing } = await supabase
      .from("contracts")
      .select("id, status")
      .eq("guru_transaction_id", sale.transactionId)
      .maybeSingle();
    contractId = existing && ["received", "error"].includes(existing.status)
      ? (existing.id as string)
      : null;
  }
  if (contractId) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    fetch(`${supabaseUrl}/functions/v1/generate-contract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ contract_id: contractId }),
    }).catch((e) => console.error("guru-webhook: trigger generate-contract falhou:", e));
  }

  // TODO Etapa 3: criar envelope na Clicksign (sandbox) e salvar envelope_id

  return jsonResponse({
    received: true,
    processed: true,
    duplicate: !isNew,
    contract_id: contract?.id ?? null,
  });
});
