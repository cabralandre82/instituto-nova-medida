/**
 * Testes de ensurePaymentForFulfillment (D-044 · 2.C.2).
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

  it("cria novo quando payment anterior está em status não reusável", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFfRow({
        payment_id: "pay-old",
        customer: {
          ...mkFfRow().customer,
          asaas_customer_id: "asaas-cust-1",
          asaas_env: "sandbox",
        },
      }),
      error: null,
    });
    supa.enqueue("payments", {
      data: {
        id: "pay-old",
        status: "DELETED",
        invoice_url: null,
        amount_cents: 179700,
        asaas_payment_id: "asaas-old",
      },
      error: null,
    });
    // insert payment new
    supa.enqueue("payments", { data: { id: "pay-new" }, error: null });
    vi.mocked(createPayment).mockResolvedValue({
      ok: true,
      env: "sandbox",
      data: {
        id: "asaas-new",
        customer: "asaas-cust-1",
        value: 1797,
        billingType: "UNDEFINED",
        status: "PENDING",
        dueDate: "2026-04-23",
        invoiceUrl: "https://asaas.com/i/new",
      },
    });
    // update payment
    supa.enqueue("payments", { data: null, error: null });
    // link ff→payment
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await ensurePaymentForFulfillment(supa.client as never, "ff-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyExisted).toBe(false);
    expect(res.paymentId).toBe("pay-new");
    expect(vi.mocked(createCustomer)).not.toHaveBeenCalled();
    expect(vi.mocked(createPayment)).toHaveBeenCalledTimes(1);
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
    // insert payment local
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
    supa.enqueue("payments", { data: { id: "pay-1" }, error: null });
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
});

describe("ensurePaymentForFulfillment · falhas do Asaas", () => {
  it("retorna asaas_customer_error quando createCustomer falha", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: mkFfRow(), error: null });
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
    supa.enqueue("payments", { data: { id: "pay-1" }, error: null });
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
    // devia ter marcado payment como DELETED
    const deletedCall = supa.calls.find(
      (c) =>
        c.table === "payments" &&
        c.chain.includes("update") &&
        JSON.stringify(c.args).includes("DELETED")
    );
    expect(deletedCall).toBeTruthy();
  });
});
