// Edge function: get-signature-key (Etapa 4 do fluxo Guru → Clicksign)
// A página pós-pagamento consulta pelo id da transação do Guru e recebe o
// status do contrato + a key do signatário quando o envelope está running —
// é essa key que carrega o widget embedded da Clicksign na página.
//
// Pública (verify_jwt = false): quem conhece o id da transação é quem acabou
// de pagar (o Guru devolve esse id no redirect do checkout). A key só permite
// assinar o próprio contrato — não expõe dados além do necessário ao widget.
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

  // GET ?transaction_id=... (a página pode fazer polling simples)
  let transactionId: string | null = null;
  if (req.method === "GET") {
    transactionId = new URL(req.url).searchParams.get("transaction_id");
  } else if (req.method === "POST") {
    try {
      ({ transaction_id: transactionId = null } = await req.json());
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }
  } else {
    return jsonResponse({ error: "Method not allowed" }, 405);
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
    .select("status, clicksign_signer_key, customer_name, terms_accepted_at")
    .eq("guru_transaction_id", transactionId)
    .maybeSingle();
  if (error) return jsonResponse({ error: error.message }, 500);
  if (!contract) {
    // Contrato ainda não chegou (webhook do Guru pode levar alguns segundos)
    return jsonResponse({ found: false, status: null, terms_accepted: false, signer_key: null }, 404);
  }

  // A key só sai quando o envelope está rodando E o cliente aceitou o Termo
  // de Ciência e Aceite (accept-terms) — a ordem é garantida aqui no servidor.
  const termsAccepted = !!contract.terms_accepted_at;
  const ready = contract.status === "running" && termsAccepted &&
    !!contract.clicksign_signer_key;
  return jsonResponse({
    found: true,
    status: contract.status,
    customer_name: contract.customer_name,
    terms_accepted: termsAccepted,
    signer_key: ready ? contract.clicksign_signer_key : null,
  });
});
