/**
 * Testes da orquestração de aceite de fulfillment (D-044 · 2.C · PR-011).
 *
 * Usa createSupabaseMock pra simular o Supabase sem banco real,
 * com o mesmo padrão de enqueue-respostas dos outros testes do
 * `src/lib/`.
 *
 * Cobre:
 *   - payload inválido (versão de termo desconhecida — PR-011);
 *   - not_found;
 *   - forbidden (nenhum dos proprietários bate);
 *   - invalid_state (cancelled, shipped, etc.);
 *   - idempotência (pending_payment já aceito devolve registro);
 *   - invalid_address (erros agregados);
 *   - plano inativo / prescrição ausente;
 *   - happy path (aceite grava customer + acceptance + fulfillment);
 *   - unique collision (23505) → já-aceito idempotente;
 *   - falha de DB no UPDATE final → retorna db_error mas aceite
 *     gravado (idempotência na próxima tentativa);
 *   - texto gravado é sempre server-authoritative (PR-011 / audit [6.1]).
 */

import { describe, it, expect } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import { acceptFulfillment } from "./fulfillment-acceptance";
import { ACCEPTANCE_TERMS_VERSION } from "./acceptance-terms";

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

const VALID_ADDRESS = {
  zipcode: "01310-100",
  street: "Avenida Paulista",
  number: "1000",
  complement: "apto 12",
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
};

const FULL_FF_ROW = {
  id: "ff-1",
  status: "pending_acceptance",
  customer_id: "cust-1",
  appointment_id: "appt-1",
  plan_id: "plan-1",
  doctor_id: "doc-1",
  appointment: {
    id: "appt-1",
    memed_prescription_url: "https://memed.com.br/prescription/abc",
    status: "completed",
  },
  plan: {
    id: "plan-1",
    slug: "tirzepatida-90",
    name: "Tirzepatida 90 dias",
    medication: "Tirzepatida 2,5 a 7,5 mg/sem",
    cycle_days: 90,
    price_pix_cents: 179700,
    active: true,
  },
  customer: {
    id: "cust-1",
    name: "Maria da Silva",
    cpf: "12345678900",
    user_id: "user-1",
  },
  doctor: {
    id: "doc-1",
    full_name: "Dra. Joana Almeida",
    display_name: null,
    crm_number: "123456",
    crm_uf: "SP",
  },
};

function validInput() {
  return {
    terms_version: ACCEPTANCE_TERMS_VERSION,
    address: { ...VALID_ADDRESS },
    user_agent: "vitest",
    ip_address: "127.0.0.1",
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("acceptFulfillment · validações rápidas", () => {
  it("rejeita terms_version desconhecida (client stale ou adulterado)", async () => {
    const supa = createSupabaseMock();
    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: {
        terms_version: "v99-fake",
        address: VALID_ADDRESS,
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
    // não deve ter chamado o banco — fail fast antes de qualquer query
    expect(supa.calls).toHaveLength(0);
  });

  it("aceita quando terms_version é omitida — usa a vigente", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: {
        address: { ...VALID_ADDRESS },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("retorna not_found quando fulfillment não existe", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-404",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("not_found");
  });

  it("retorna db_error quando SELECT do fulfillment falha", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "timeout" },
    });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("db_error");
  });
});

describe("acceptFulfillment · ownership", () => {
  it("rejeita quando nem userId nem customerId batem com o fulfillment", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "outro-user",
      customerId: null,
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("forbidden");
  });

  it("aceita por customerId quando userId ausente (fluxo via token HMAC)", async () => {
    const supa = createSupabaseMock();
    const ff = { ...FULL_FF_ROW, customer: { ...FULL_FF_ROW.customer, user_id: null } };
    supa.enqueue("fulfillments", { data: ff, error: null });
    supa.enqueue("customers", { data: null, error: null }); // update customer
    supa.enqueue("plan_acceptances", {
      data: { id: "acc-1" },
      error: null,
    }); // insert
    supa.enqueue("fulfillments", { data: null, error: null }); // update

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: null,
      customerId: "cust-1",
      input: validInput(),
    });
    expect(res.ok).toBe(true);
  });
});

describe("acceptFulfillment · estado", () => {
  it("rejeita quando fulfillment está cancelled", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: { ...FULL_FF_ROW, status: "cancelled" },
      error: null,
    });
    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });

  it("rejeita quando fulfillment está shipped", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: { ...FULL_FF_ROW, status: "shipped" },
      error: null,
    });
    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });

  it("idempotente: fulfillment já em pending_payment devolve registro existente", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: { ...FULL_FF_ROW, status: "pending_payment" },
      error: null,
    });
    supa.enqueue("plan_acceptances", {
      data: {
        id: "acc-existing",
        acceptance_hash: "deadbeef",
        shipping_snapshot: {
          recipient_name: "Maria",
          zipcode: "01310100",
          street: "Avenida Paulista",
          number: "1000",
          complement: null,
          district: "Bela Vista",
          city: "São Paulo",
          state: "SP",
        },
      },
      error: null,
    });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyAccepted).toBe(true);
    expect(res.acceptanceId).toBe("acc-existing");
    expect(res.acceptanceHash).toBe("deadbeef");
  });
});

describe("acceptFulfillment · plano/prescrição", () => {
  it("rejeita se plano está inativo", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: {
        ...FULL_FF_ROW,
        plan: { ...FULL_FF_ROW.plan, active: false },
      },
      error: null,
    });
    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });

  it("rejeita se prescrição Memed está ausente", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: {
        ...FULL_FF_ROW,
        appointment: { ...FULL_FF_ROW.appointment, memed_prescription_url: null },
      },
      error: null,
    });
    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });
});

describe("acceptFulfillment · endereço", () => {
  it("retorna invalid_address com errors agregados quando validate falha", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: {
        terms_version: ACCEPTANCE_TERMS_VERSION,
        address: {
          zipcode: "xx",
          street: "",
          number: "",
          district: "",
          city: "",
          state: "ZZ",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_address");
    expect(res.addressErrors).toBeDefined();
    expect(Object.keys(res.addressErrors ?? {})).toContain("zipcode");
    expect(Object.keys(res.addressErrors ?? {})).toContain("state");
  });
});

describe("acceptFulfillment · happy path", () => {
  it("grava customer + acceptance + fulfillment e retorna success", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null }); // update customer
    supa.enqueue("plan_acceptances", {
      data: { id: "acc-1" },
      error: null,
    }); // insert
    supa.enqueue("fulfillments", { data: null, error: null }); // update

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fulfillmentId).toBe("ff-1");
    expect(res.acceptanceId).toBe("acc-1");
    expect(res.acceptanceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.snapshot.zipcode).toBe("01310100");
    expect(res.snapshot.state).toBe("SP");
    expect(res.alreadyAccepted).toBe(false);
    expect(res.fulfillmentStatus).toBe("pending_payment");
  });

  it("PR-064 · D-072 · grava user_email em plan_acceptances + updated_by_email em fulfillments", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      userEmail: "  MARIA@Example.COM  ",
      input: validInput(),
    });
    expect(res.ok).toBe(true);

    const paInsertCall = supa.calls.find(
      (c) => c.table === "plan_acceptances" && c.chain.includes("insert")
    );
    const paRow = paInsertCall!.args[
      paInsertCall!.chain.indexOf("insert")
    ][0] as Record<string, unknown>;
    // Snapshot normalizado: trim + lowercase.
    expect(paRow.user_email).toBe("maria@example.com");
    expect(paRow.user_id).toBe("user-1");

    // E no fulfillment também é registrado.
    const ffUpdCall = supa.calls
      .filter((c) => c.table === "fulfillments" && c.chain.includes("update"))
      .pop();
    const ffPatch = ffUpdCall!.args[
      ffUpdCall!.chain.indexOf("update")
    ][0] as Record<string, unknown>;
    expect(ffPatch.updated_by_email).toBe("maria@example.com");
  });

  it("PR-064 · userEmail omitido → snapshots null (legado/compat)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(true);

    const paInsertCall = supa.calls.find(
      (c) => c.table === "plan_acceptances" && c.chain.includes("insert")
    );
    const paRow = paInsertCall!.args[
      paInsertCall!.chain.indexOf("insert")
    ][0] as Record<string, unknown>;
    expect(paRow.user_email).toBeNull();
  });

  it("snapshot fica com recipient_name = nome do paciente quando não informado", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot.recipient_name).toBe("Maria da Silva");
  });

  it("PR-011 · grava acceptance_text renderizado server-side com dados do banco", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(true);

    // Identifica a chamada insert em plan_acceptances
    const paInsertCall = supa.calls.find(
      (c) => c.table === "plan_acceptances" && c.chain.includes("insert")
    );
    expect(paInsertCall).toBeDefined();
    const insertArgs = paInsertCall!.args[paInsertCall!.chain.indexOf("insert")];
    const row = insertArgs[0] as Record<string, unknown>;

    // Texto **renderizado pelo servidor** com dados do banco.
    // Verifica marcadores que só existem no template + dados reais.
    const text = row.acceptance_text as string;
    expect(text).toContain("TERMO DE CONSENTIMENTO");
    expect(text).toContain("Maria da Silva");
    expect(text).toContain("123.456.789-00"); // CPF formatado pelo servidor
    expect(text).toContain("Tirzepatida 90 dias");
    // Intl.NumberFormat pt-BR usa NBSP entre "R$" e valor. Regex
    // tolerante pra não depender do whitespace exato.
    expect(text).toMatch(/R\$\s+1\.797,00/);
    expect(text).toContain("123456/SP"); // CRM formatado
    expect(text).toContain("Dra. Joana Almeida");
    expect(text).toContain("https://memed.com.br/prescription/abc");
    expect(text).not.toMatch(/\{\w+\}/); // sem placeholders sobrando
    expect(text.length).toBeGreaterThan(1500);

    // Versão declarada é persistida.
    expect(row.terms_version).toBe(ACCEPTANCE_TERMS_VERSION);

    // Hash é sha256 do texto + contexto.
    expect(row.acceptance_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PR-011 · texto gravado ignora qualquer acceptance_text hipotético do cliente", async () => {
    // Cenário adversário: mesmo que o cliente tentasse injetar um campo
    // acceptance_text (agora não mais no tipo público), o servidor
    // renderiza a partir do banco e grava o texto server-authoritative.
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    // Simulando cliente malicioso que injeta um campo desconhecido
    // — o servidor deve ignorá-lo e renderizar a partir do banco.
    const adversarial = {
      ...validInput(),
      acceptance_text: "EU ACEITO PAGAR R$ 1,00 E GANHAR 1 MILHÃO.",
    } as unknown as Parameters<typeof acceptFulfillment>[1]["input"];

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: adversarial,
    });
    expect(res.ok).toBe(true);

    const paInsertCall = supa.calls.find(
      (c) => c.table === "plan_acceptances" && c.chain.includes("insert")
    );
    const row = paInsertCall!.args[paInsertCall!.chain.indexOf("insert")][0] as Record<string, unknown>;
    const text = row.acceptance_text as string;

    expect(text).not.toContain("GANHAR 1 MILHÃO");
    expect(text).toContain("TERMO DE CONSENTIMENTO");
    expect(text).toMatch(/R\$\s+1\.797,00/);
  });

  it("hash muda se paciente editar endereço (regressão: CEP diferente → hash diferente)", async () => {
    const supa1 = createSupabaseMock();
    supa1.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa1.enqueue("customers", { data: null, error: null });
    supa1.enqueue("plan_acceptances", { data: { id: "acc-A" }, error: null });
    supa1.enqueue("fulfillments", { data: null, error: null });

    const r1 = await acceptFulfillment(supa1.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });

    const supa2 = createSupabaseMock();
    supa2.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa2.enqueue("customers", { data: null, error: null });
    supa2.enqueue("plan_acceptances", { data: { id: "acc-B" }, error: null });
    supa2.enqueue("fulfillments", { data: null, error: null });

    const r2 = await acceptFulfillment(supa2.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: {
        ...validInput(),
        address: { ...VALID_ADDRESS, zipcode: "04538-132" },
      },
    });

    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.acceptanceHash).not.toBe(r2.acceptanceHash);
    }
  });
});

describe("acceptFulfillment · concorrência e falhas", () => {
  it("unique collision (23505) no insert de acceptance → idempotência", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    supa.enqueue("plan_acceptances", {
      data: { id: "acc-race-winner", acceptance_hash: "abc" },
      error: null,
    });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyAccepted).toBe(true);
    expect(res.acceptanceId).toBe("acc-race-winner");
  });

  it("falha no UPDATE do fulfillment após insert → db_error (aceite persistido)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "connection reset" },
    });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("db_error");
  });

  it("falha no UPDATE de customer NÃO aborta o aceite (log-and-continue)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: FULL_FF_ROW, error: null });
    supa.enqueue("customers", {
      data: null,
      error: { message: "concurrent update" },
    });
    supa.enqueue("plan_acceptances", { data: { id: "acc-1" }, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await acceptFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      userId: "user-1",
      input: validInput(),
    });
    expect(res.ok).toBe(true);
  });
});
