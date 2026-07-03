import { describe, expect, it } from "vitest";
import {
  activateEnvelope,
  buildAuthRequirementPayload,
  buildAutoSignerPayload,
  buildClientSignerPayload,
  buildEnvelopePayload,
  buildSignRequirementPayload,
  bytesToBase64,
  ClicksignApiError,
  clicksignRequest,
  createEnvelopeResources,
  DOCX_MIME,
  docxToContentBase64,
  type CreateEnvelopeInput,
} from "./clicksign";

const CLIENT = {
  name: "Maria Teste",
  email: "maria@teste.com",
  phoneNumber: "+5511999999999",
  documentation: "123.456.789-09",
  docType: "cpf",
};

const ICOMM = {
  name: "Icomm Group LTDA",
  email: "contratos@icomm.com.br",
  birthday: "1990-01-01",
  documentation: "111.222.333-44",
};

describe("bytesToBase64 / docxToContentBase64", () => {
  it("codifica bytes como o Buffer do Node", () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 255, 0, 128]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("aguenta payloads maiores que um chunk (64 KB)", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("monta o data URI com o MIME de docx", () => {
    const uri = docxToContentBase64(new Uint8Array([1, 2, 3]));
    expect(uri).toBe(`data:${DOCX_MIME};base64,AQID`);
  });
});

describe("payloads JSON:API", () => {
  it("envelope: pt-BR com auto_close", () => {
    expect(buildEnvelopePayload("Contrato X")).toEqual({
      data: {
        type: "envelopes",
        attributes: { name: "Contrato X", locale: "pt-BR", auto_close: true },
      },
    });
  });

  it("signatário cliente: grupo 1, com CPF", () => {
    const p = buildClientSignerPayload(CLIENT);
    expect(p.data.type).toBe("signers");
    expect(p.data.attributes).toMatchObject({
      name: "Maria Teste",
      email: "maria@teste.com",
      phone_number: "+5511999999999",
      has_documentation: true,
      documentation: "123.456.789-09",
      refusable: false,
      group: 1,
    });
  });

  it("signatário cliente: compra por CNPJ vai sem documentation", () => {
    const p = buildClientSignerPayload({
      ...CLIENT,
      documentation: "12.345.678/0001-90",
      docType: "cnpj",
    });
    expect(p.data.attributes.has_documentation).toBe(false);
    expect(p.data.attributes).not.toHaveProperty("documentation");
  });

  it("signatário Icomm: grupo 2 (assina depois do cliente), dados do termo", () => {
    const p = buildAutoSignerPayload(ICOMM);
    expect(p.data.attributes).toMatchObject({
      name: "Icomm Group LTDA",
      birthday: "1990-01-01",
      documentation: "111.222.333-44",
      has_documentation: true,
      group: 2,
    });
  });

  it("requisito de assinatura liga documento e signatário", () => {
    expect(buildSignRequirementPayload("doc-1", "sig-1")).toEqual({
      data: {
        type: "requirements",
        attributes: { action: "agree", role: "sign" },
        relationships: {
          document: { data: { type: "documents", id: "doc-1" } },
          signer: { data: { type: "signers", id: "sig-1" } },
        },
      },
    });
  });

  it("requisito de autenticação usa provide_evidence + auth", () => {
    const p = buildAuthRequirementPayload("doc-1", "sig-2", "auto_signature");
    expect(p.data.attributes).toEqual({
      action: "provide_evidence",
      auth: "auto_signature",
    });
  });
});

/** fetch fake: registra chamadas e responde da fila */
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const next = responses[calls.length] ?? { body: {} };
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const CONFIG = (fetchFn: typeof fetch) => ({
  baseUrl: "https://sandbox.clicksign.com/api/v3",
  apiToken: "tok-123",
  fetchFn,
});

describe("clicksignRequest", () => {
  it("manda Authorization sem Bearer e Content-Type vnd.api+json", async () => {
    const { calls, fetchFn } = fakeFetch([{ body: { data: { id: "1", type: "envelopes" } } }]);
    await clicksignRequest(CONFIG(fetchFn), "POST", "/envelopes", { a: 1 });
    expect(calls[0].url).toBe("https://sandbox.clicksign.com/api/v3/envelopes");
    expect(calls[0].headers).toEqual({
      Authorization: "tok-123",
      "Content-Type": "application/vnd.api+json",
    });
  });

  it("erro JSON:API vira ClicksignApiError com os details", async () => {
    const { fetchFn } = fakeFetch([
      {
        status: 422,
        body: { errors: [{ title: "Invalid", detail: "signer sem termo vigente" }] },
      },
    ]);
    const err = await clicksignRequest(CONFIG(fetchFn), "POST", "/envelopes", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ClicksignApiError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("signer sem termo vigente");
  });
});

describe("createEnvelopeResources", () => {
  const INPUT: CreateEnvelopeInput = {
    envelopeName: "Contrato Mentoria — Maria Teste",
    docxFilename: "contrato-mentoria-ads-04.docx",
    contentBase64: "data:x;base64,AQID",
    client: CLIENT,
    clientAuth: "email",
    icomm: ICOMM,
  };

  function happyResponses() {
    return [
      { body: { data: { id: "env-1", type: "envelopes" } } },
      { body: { data: { id: "doc-1", type: "documents" } } },
      { body: { data: { id: "sig-cli", type: "signers", attributes: { key: "widget-key-abc" } } } },
      { body: { data: { id: "sig-ico", type: "signers", attributes: {} } } },
      { body: { data: { id: "req-1", type: "requirements" } } },
      { body: { data: { id: "req-2", type: "requirements" } } },
      { body: { data: { id: "req-3", type: "requirements" } } },
      { body: { data: { id: "req-4", type: "requirements" } } },
    ];
  }

  it("executa a sequência draft → documento → signatários → 4 requisitos", async () => {
    const { calls, fetchFn } = fakeFetch(happyResponses());
    const result = await createEnvelopeResources(CONFIG(fetchFn), INPUT);

    expect(calls.map((c) => `${c.method} ${c.url.replace("https://sandbox.clicksign.com/api/v3", "")}`)).toEqual([
      "POST /envelopes",
      "POST /envelopes/env-1/documents",
      "POST /envelopes/env-1/signers",
      "POST /envelopes/env-1/signers",
      "POST /envelopes/env-1/requirements",
      "POST /envelopes/env-1/requirements",
      "POST /envelopes/env-1/requirements",
      "POST /envelopes/env-1/requirements",
    ]);

    // requisitos: assinar (cliente, icomm) + autenticação (cliente email, icomm auto)
    const reqs = calls.slice(4).map((c) => (c.body as { data: { attributes: unknown; relationships: { signer: { data: { id: string } } } } }).data);
    expect(reqs[0].attributes).toEqual({ action: "agree", role: "sign" });
    expect(reqs[0].relationships.signer.data.id).toBe("sig-cli");
    expect(reqs[1].relationships.signer.data.id).toBe("sig-ico");
    expect(reqs[2].attributes).toEqual({ action: "provide_evidence", auth: "email" });
    expect(reqs[3].attributes).toEqual({ action: "provide_evidence", auth: "auto_signature" });

    expect(result).toEqual({
      envelopeId: "env-1",
      documentId: "doc-1",
      clientSignerId: "sig-cli",
      clientSignerKey: "widget-key-abc",
      icommSignerId: "sig-ico",
    });
  });

  it("signatário sem key no retorno → clientSignerKey null (não quebra)", async () => {
    const responses = happyResponses();
    responses[2] = { body: { data: { id: "sig-cli", type: "signers" } } };
    const { fetchFn } = fakeFetch(responses);
    const result = await createEnvelopeResources(CONFIG(fetchFn), INPUT);
    expect(result.clientSignerKey).toBeNull();
  });

  it("falha no meio propaga o erro da API (nada é engolido)", async () => {
    const responses = happyResponses().slice(0, 2);
    responses.push({
      status: 422,
      body: { errors: [{ title: "Unprocessable", detail: "documentation inválida" }] },
    });
    const { fetchFn } = fakeFetch(responses);
    await expect(createEnvelopeResources(CONFIG(fetchFn), INPUT)).rejects.toThrow(
      "documentation inválida",
    );
  });
});

describe("activateEnvelope", () => {
  it("PATCH /envelopes/:id com status running", async () => {
    const { calls, fetchFn } = fakeFetch([{ body: { data: { id: "env-1", type: "envelopes" } } }]);
    await activateEnvelope(CONFIG(fetchFn), "env-1");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/envelopes/env-1");
    expect(calls[0].body).toEqual({
      data: { id: "env-1", type: "envelopes", attributes: { status: "running" } },
    });
  });
});
