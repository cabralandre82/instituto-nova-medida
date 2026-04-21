/**
 * Testes de ensurePaymentForFulfillment (D-044 · 2.C.2 · PR-015).
 *
 * Mockamos `./asaas` pra isolar da rede. O mock do Supabase continua
 * com enqueue por tabela, como nos outros testes.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import { ensurePaymentForFulfillment } from "./fulfillment-payment";

vi.mock("./asaas", async () => {
  const actual = await vi.importActual<typeof import("./asaas")>("./asaas");
  return {
    ...actual,
    getAsaasEnv: vi.fn(() => "sandbox" as const),
    createCustomer: vi.fn(),
    createPayment: vi.fn(),
  };
});

import { createCustomer, createPayment, getAsaasEnv } from "./asaas";

const mkFfRow = (overrides?: Partial<Record<string, unknown>>) => ({
  id: "ff-1",
  status: "pending_payment",
  payment_id: null,
  customer_id: "cust-1",
  plan_id: "plan-1",
  customer: {
    id: "cust-1",
    name: "Maria da Silva",
    cpf: "12345678900",
    email: "maria@ex.com",
    phone: "11999999999",
    address_zipcode: "01310100",
    address_street: "Avenida Paulista",
    address_number: "1000",
    address_complement: null,
    address_district: "Bela Vista",
    address_city: "São Paulo",
    address_state: "SP",
    asaas_customer_id: null,
    asaas_env: null,
  },
  plan: {
    id: "plan-1",
    name: "Tirzepatida 90 dias",
    slug: "tirzepatida-90",
    cycle_days: 90,
    price_pix_cents: 179700,
    price_cents: 197000,
    active: true,
  },
  ...overrides,
});

beforeEach(() => {
  vi.mocked(getAsaasEnv).mockReturnValue("sandbox");
  vi.mocked(createCustomer).mockReset();
  vi.mocked(createPayment).mockReset();
});

describe("ensurePaymentForFulfillment · reuso (idempotência)", () => {
  it("devolve invoice_url existente quando payment está PENDING", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFfRow({ payment_id: "pay-1" }),
      error: null,
    });
    // PR-015: lookup agora por fulfillment_id (findAlive).
    supa.enqueue("payments", {
      data: {
        id: "pay-1",
        status: "PENDING",
        invoice_url: "https://asaas.com/i/abc",
        amount_cents: 179700,
        asaas_payment_id: "asaas-1",
      },
      error: null,
    });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyExisted).toBe(true);
    expect(res.invoiceUrl).toBe("https://asaas.com/i/abc");
    // não deve ter chamado Asaas
    expect(vi.mocked(createCustomer)).not.toHaveBeenCalled();
    expect(vi.mocked(createPayment)).not.toHaveBeenCalled();
  });

  it("PR-015 · recupera link quando fulfillments.payment_id ficou desincronizado", async () => {
    // Cenário: insert do payment funcionou mas o update do
    // fulfillments.payment_id falhou na chamada anterior. Agora
    // `findAlivePaymentForFulfillment` encontra a cobrança viva e
    // o código deve re-vincular antes de devolver.
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFfRow({ payment_id: null }),
      error: null,
    });
    supa.enqueue("payments", {
      data: {
        id: "pay-orphan",
        status: "PENDING",
        invoice_url: "https://asaas.com/i/orph",
        amount_cents: 179700,
        asaas_payment_id: "asaas-orph",
      },
      error: null,
    });
    // Relink fulfillments.payment_id
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyExisted).toBe(true);
    expect(res.paymentId).toBe("pay-orphan");

    const relinkCall = supa.calls.find(
      (c) =>
        c.table === "fulfillments" &&
        c.chain.includes("update") &&
        JSON.stringify(c.args).includes("pay-orphan")
    );
    expect(relinkCall).toBeTruthy();
  });
});

describe("ensurePaymentForFulfillment · validações", () => {
  it("rejeita quando fulfillment não existe", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-404");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("not_found");
  });

  it("rejeita status != pending_payment", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFfRow({ status: "pending_acceptance" }),
      error: null,
    });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });

  it("rejeita quando plano está inativo", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFfRow({
        plan: { ...mkFfRow().plan, active: false },
      }),
      error: null,
    });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });
});

describe("ensurePaymentForFulfillment · criação (happy path)", () => {
  it("cria customer Asaas + payment Asaas + payment local + vincula", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: mkFfRow(), error: null });
    // findAlive: nenhum payment ainda
    supa.enqueue("payments", { data: null, error: null });

    vi.mocked(createCustomer).mockResolvedValue({
      ok: true,
      env: "sandbox",
      data: {
        id: "asaas-cust-1",
        name: "Maria da Silva",
        cpfCnpj: "12345678900",
        email: "maria@ex.com",
      },
    });
    // update customer com asaas_customer_id
    supa.enqueue("customers", { data: null, error: null });
    // insert payment local (vincula fulfillment_id)
    supa.enqueue("payments", { data: { id: "pay-1" }, error: null });

    vi.mocked(createPayment).mockResolvedValue({
      ok: true,
      env: "sandbox",
      data: {
        id: "asaas-pay-1",
        customer: "asaas-cust-1",
        value: 1797,
        billingType: "UNDEFINED",
        status: "PENDING",
        dueDate: "2026-04-23",
        invoiceUrl: "https://asaas.com/i/xyz",
      },
    });
    // update payment com asaas data
    supa.enqueue("payments", { data: null, error: null });
    // link fulfillment → payment
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.paymentId).toBe("pay-1");
    expect(res.asaasPaymentId).toBe("asaas-pay-1");
    expect(res.invoiceUrl).toBe("https://asaas.com/i/xyz");
    expect(res.amountCents).toBe(179700);
    expect(res.alreadyExisted).toBe(false);
    expect(vi.mocked(createCustomer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPayment)).toHaveBeenCalledTimes(1);

    // PR-015: o insert deve conter fulfillment_id.
    const insertCall = supa.calls.find(
      (c) =>
        c.table === "payments" &&
        c.chain.includes("insert") &&
        JSON.stringify(c.args).includes('"fulfillment_id":"ff-1"')
    );
    expect(insertCall).toBeTruthy();
  });

  it("reutiliza asaas_customer_id quando já existe no mesmo env", async () => {
    const supa = createSupabaseMock();
    const ff = mkFfRow({
      customer: {
        ...mkFfRow().customer,
        asaas_customer_id: "asaas-cust-existing",
        asaas_env: "sandbox",
      },
    });
    supa.enqueue("fulfillments", { data: ff, error: null });
    supa.enqueue("payments", { data: null, error: null }); // findAlive
    supa.enqueue("payments", { data: { id: "pay-1" }, error: null }); // insert
    vi.mocked(createPayment).mockResolvedValue({
      ok: true,
      env: "sandbox",
      data: {
        id: "asaas-pay-1",
        customer: "asaas-cust-existing",
        value: 1797,
        billingType: "UNDEFINED",
        status: "PENDING",
        dueDate: "2026-04-23",
        invoiceUrl: "https://asaas.com/i/xyz",
      },
    });
    supa.enqueue("payments", { data: null, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(true);
    expect(vi.mocked(createCustomer)).not.toHaveBeenCalled();
  });

  it("limpa payment 'vivo mas inútil' (PENDING sem invoice_url) antes de criar novo", async () => {
    // Cenário: payment anterior existe em PENDING mas sem invoice_url
    // (Asaas falhou no meio do round-trip). Precisamos marcar DELETED
    // pra liberar o unique parcial e criar um novo.
    const supa = createSupabaseMock();
    const ff = mkFfRow({
      customer: {
        ...mkFfRow().customer,
        asaas_customer_id: "asaas-cust-1",
        asaas_env: "sandbox",
      },
    });
    supa.enqueue("fulfillments", { data: ff, error: null });
    // findAlive: retorna row "viva mas inútil".
    supa.enqueue("payments", {
      data: {
        id: "pay-stale",
        status: "PENDING",
        invoice_url: null,
        amount_cents: 179700,
        asaas_payment_id: null,
      },
      error: null,
    });
    // mark DELETED na row stale
    supa.enqueue("payments", { data: null, error: null });
    // insert novo payment
    supa.enqueue("payments", { data: { id: "pay-new" }, error: null });
    vi.mocked(createPayment).mockResolvedValue({
      ok: true,
      env: "sandbox",
      data: {
        id: "asaas-pay-new",
        customer: "asaas-cust-1",
        value: 1797,
        billingType: "UNDEFINED",
        status: "PENDING",
        dueDate: "2026-04-23",
        invoiceUrl: "https://asaas.com/i/new",
      },
    });
    supa.enqueue("payments", { data: null, error: null }); // update novo payment
    supa.enqueue("fulfillments", { data: null, error: null }); // link

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.paymentId).toBe("pay-new");
    expect(res.alreadyExisted).toBe(false);

    // Deve ter marcado a row stale como DELETED.
    const markDeadCall = supa.calls.find(
      (c) =>
        c.table === "payments" &&
        c.chain.includes("update") &&
        JSON.stringify(c.args).includes("DELETED") &&
        JSON.stringify(c.args).includes("payment_unusable_precleanup")
    );
    expect(markDeadCall).toBeTruthy();
  });
});

describe("ensurePaymentForFulfillment · race condition (PR-015)", () => {
  it("trata 23505 no insert como race perdida e devolve a row vencedora", async () => {
    const supa = createSupabaseMock();
    const ff = mkFfRow({
      customer: {
        ...mkFfRow().customer,
        asaas_customer_id: "asaas-cust-1",
        asaas_env: "sandbox",
      },
    });
    supa.enqueue("fulfillments", { data: ff, error: null });
    // findAlive inicial: nada (duas threads chegaram aqui ao mesmo tempo).
    supa.enqueue("payments", { data: null, error: null });
    // insert colide com unique parcial.
    supa.enqueue("payments", {
      data: null,
      error: { code: "23505", message: "unique violation" },
    });
    // findAlive de recovery: a outra thread finalizou e gravou a row.
    supa.enqueue("payments", {
      data: {
        id: "pay-winner",
        status: "PENDING",
        invoice_url: "https://asaas.com/i/winner",
        amount_cents: 179700,
        asaas_payment_id: "asaas-winner",
      },
      error: null,
    });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyExisted).toBe(true);
    expect(res.paymentId).toBe("pay-winner");
    expect(res.invoiceUrl).toBe("https://asaas.com/i/winner");
    // Não deve ter chamado o Asaas uma segunda vez — o insert colidiu
    // antes da chamada createPayment.
    expect(vi.mocked(createPayment)).not.toHaveBeenCalled();
  });

  it("trata 23505 + vencedora ainda sem invoice_url como erro transitório", async () => {
    const supa = createSupabaseMock();
    const ff = mkFfRow({
      customer: {
        ...mkFfRow().customer,
        asaas_customer_id: "asaas-cust-1",
        asaas_env: "sandbox",
      },
    });
    supa.enqueue("fulfillments", { data: ff, error: null });
    supa.enqueue("payments", { data: null, error: null });
    supa.enqueue("payments", {
      data: null,
      error: { code: "23505", message: "unique violation" },
    });
    // findAlive de recovery: vencedora ainda não chamou Asaas.
    supa.enqueue("payments", {
      data: {
        id: "pay-winner",
        status: "PENDING",
        invoice_url: null,
        amount_cents: 179700,
        asaas_payment_id: null,
      },
      error: null,
    });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("db_error");
    expect(res.message).toMatch(/tente novamente/i);
    expect(vi.mocked(createPayment)).not.toHaveBeenCalled();
  });
});

describe("ensurePaymentForFulfillment · falhas do Asaas", () => {
  it("retorna asaas_customer_error quando createCustomer falha", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: mkFfRow(), error: null });
    supa.enqueue("payments", { data: null, error: null }); // findAlive
    vi.mocked(createCustomer).mockResolvedValue({
      ok: false,
      status: 400,
      code: "invalid_cpf",
      message: "CPF inválido",
    });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("asaas_customer_error");
    expect(vi.mocked(createPayment)).not.toHaveBeenCalled();
  });

  it("retorna asaas_payment_error e marca payment local como DELETED", async () => {
    const supa = createSupabaseMock();
    const ff = mkFfRow({
      customer: {
        ...mkFfRow().customer,
        asaas_customer_id: "asaas-cust-1",
        asaas_env: "sandbox",
      },
    });
    supa.enqueue("fulfillments", { data: ff, error: null });
    supa.enqueue("payments", { data: null, error: null }); // findAlive
    supa.enqueue("payments", { data: { id: "pay-1" }, error: null }); // insert
    vi.mocked(createPayment).mockResolvedValue({
      ok: false,
      status: 503,
      code: "service_unavailable",
      message: "Asaas offline",
    });
    // o update de DELETED no payment local
    supa.enqueue("payments", { data: null, error: null });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("asaas_payment_error");
    // devia ter marcado payment como DELETED (liberando o slot do unique parcial)
    const deletedCall = supa.calls.find(
      (c) =>
        c.table === "payments" &&
        c.chain.includes("update") &&
        JSON.stringify(c.args).includes("DELETED")
    );
    expect(deletedCall).toBeTruthy();
  });
});
