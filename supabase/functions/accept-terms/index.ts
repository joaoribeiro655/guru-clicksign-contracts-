// Edge function: accept-terms (Etapa 4 do fluxo Guru → Clicksign)
// Registra o aceite do Termo de Ciência e Aceite pelo cliente na página
// pós-compra (checkbox), guardando data/hora e IP como evidência.
//
// Pública (verify_jwt = false), como o get-signature-key: quem conhece o id
// da transação é quem acabou de pagar. Idempotente: o primeiro aceite vale;
// repetições respondem ok sem sobrescrever a evidência original.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

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

  let transactionId: string | null = null;
  try {
    ({ transaction_id: transactionId = null } = await req.json());
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!transactionId) {
    return jsonResponse({ error: "transaction_id obrigatório" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: contract, error } = await supabase
    .from("contracts")
    .select("id, terms_accepted_at")
    .eq("guru_transaction_id", transactionId)
    .maybeSingle();
  if (error) return jsonResponse({ error: error.message }, 500);
  if (!contract) return jsonResponse({ accepted: false, found: false }, 404);

  if (contract.terms_accepted_at) {
    return jsonResponse({ accepted: true, accepted_at: contract.terms_accepted_at });
  }

  // IP do cliente via gateway (evidência complementar do aceite)
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const acceptedAt = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("contracts")
    .update({ terms_accepted_at: acceptedAt, terms_accepted_ip: ip })
    .eq("id", contract.id)
    .is("terms_accepted_at", null);
  if (updErr) return jsonResponse({ error: updErr.message }, 500);

  console.log(`accept-terms: aceite registrado para transação ${transactionId}`);
  return jsonResponse({ accepted: true, accepted_at: acceptedAt });
});
