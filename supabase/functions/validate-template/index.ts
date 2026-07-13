// Edge function: validate-template (painel administrativo)
// Recebe um .docx candidato a modelo de contrato (base64) e responde quais
// placeholders {{CHAVE}} ele contém, comparando com a lista oficial que o
// generate-contract sabe preencher — o painel mostra isso ANTES de salvar,
// para nenhum modelo quebrado entrar no ar.
//
// Auth: exige usuário logado (Supabase Auth) presente na whitelist
// admin_users. verify_jwt do gateway já barra requests sem JWT do projeto.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { listDocxPlaceholders } from "../_shared/docx.ts";
import { KNOWN_PLACEHOLDERS } from "../_shared/contract-data.ts";

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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Quem chama é o painel, com o JWT do usuário logado
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !userData?.user) {
    return jsonResponse({ error: "Não autenticado" }, 401);
  }
  const { data: admin } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (!admin) {
    return jsonResponse({ error: "Acesso restrito a administradores" }, 403);
  }

  let contentBase64: string | undefined;
  try {
    ({ content_base64: contentBase64 } = await req.json());
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!contentBase64) {
    return jsonResponse({ error: "content_base64 obrigatório (docx em base64, sem data URI)" }, 400);
  }

  try {
    const bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0));
    const placeholders = await listDocxPlaceholders(bytes);
    const known = new Set<string>(KNOWN_PLACEHOLDERS);
    const unknown = placeholders.filter((p) => !known.has(p));
    const missing = KNOWN_PLACEHOLDERS.filter((p) => !placeholders.includes(p));

    return jsonResponse({
      // ok = dá para usar: tem pelo menos um placeholder e nenhum desconhecido
      ok: placeholders.length > 0 && unknown.length === 0,
      placeholders,
      // desconhecidos NUNCA serão preenchidos → o contrato sairia quebrado
      unknown,
      // ausentes são só aviso: o modelo pode legitimamente não usar todos
      missing,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: `Arquivo não parece um .docx válido: ${msg}` }, 422);
  }
});
