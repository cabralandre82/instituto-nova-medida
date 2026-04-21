/**
 * Testes unitários — reconciliation.ts (D-038).
 *
 * Foco:
 *   1. KIND_LABELS cobre exaustivamente DiscrepancyKind (se alguém
 *      adicionar um kind novo e esquecer da label, o teste quebra).
 *   2. Severidade de cada kind está correta (4 críticos, 2 warnings
 *      por design — D-037).
 *   3. runReconciliation devolve estrutura coerente mesmo com DB
 *      totalmente vazio (o caso "tudo em dia" precisa ser sólido,
 *      porque é o que admin vai ver em 99% das rodadas).
 *   4. getReconciliationCounts devolve só os dois contadores, sem
 *      vazar detalhes (proteção do contrato pro dashboard).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";

vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  getSupabaseAnon: vi.fn(),
}));

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  KIND_LABELS,
  getReconciliationCounts,
  runReconciliation,
  type DiscrepancyKind,
} from "@/lib/reconciliation";

let supa: ReturnType<typeof createSupabaseMock>;

beforeEach(() => {
  supa = createSupabaseMock();
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    supa.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
});

afterEach(() => {
  supa.reset();
  vi.clearAllMocks();
});

describe("KIND_LABELS", () => {
  // Referência exaustiva dos kinds atuais. Se alguém adicionar um
  // kind novo no tipo DiscrepancyKind, precisa atualizar esta lista
  // (ou o teste quebra, que é o ponto).
  const ALL_KINDS: DiscrepancyKind[] = [
    "consultation_without_earning",
    "no_show_doctor_without_clawback",
    "payout_paid_earnings_not_paid",
    "payout_amount_drift",
    "earning_available_stale",
    "refund_required_stale",
  ];

  it("cobre todos os DiscrepancyKind", () => {
    for (const kind of ALL_KINDS) {
      expect(KIND_LABELS[kind]).toBeDefined();
      expect(KIND_LABELS[kind].label).toBeTruthy();
      expect(KIND_LABELS[kind].description).toBeTruthy();
    }
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("tem exatamente 4 críticos e 2 warnings (design D-037)", () => {
    const entries = Object.values(KIND_LABELS);
    const criticals = entries.filter((e) => e.severity === "critical");
    const warnings = entries.filter((e) => e.severity === "warning");
    expect(criticals).toHaveLength(4);
    expect(warnings).toHaveLength(2);
  });

  it("marca os 4 kinds de dinheiro-fora-do-lugar como critical", () => {
    // Esses são os 4 problemas que envolvem dinheiro real divergente.
    expect(KIND_LABELS.consultation_without_earning.severity).toBe("critical");
    expect(KIND_LABELS.no_show_doctor_without_clawback.severity).toBe(
      "critical"
    );
    expect(KIND_LABELS.payout_paid_earnings_not_paid.severity).toBe("critical");
    expect(KIND_LABELS.payout_amount_drift.severity).toBe("critical");
  });

  it("marca os 2 kinds de 'parado há muito tempo' como warning", () => {
    expect(KIND_LABELS.earning_available_stale.severity).toBe("warning");
    expect(KIND_LABELS.refund_required_stale.severity).toBe("warning");
  });
});

describe("runReconciliation", () => {
  /**
   * Enfileira respostas vazias em excesso pra todas as tabelas que
   * os 6 checks podem consultar. `Promise.all` executa os checks em
   * paralelo e a ordem de consumo da fila varia, então preencher
   * mais respostas do que o necessário é mais simples do que tentar
   * adivinhar a ordem exata.
   */
  function enqueueAllEmpty() {
    for (let i = 0; i < 6; i++) {
      supa.enqueue("appointments", { data: [], error: null });
      supa.enqueue("doctor_earnings", { data: [], error: null });
      supa.enqueue("doctor_payouts", { data: [], error: null });
    }
  }

  it("devolve report vazio coerente quando não há dados", async () => {
    enqueueAllEmpty();

    const report = await runReconciliation();

    expect(report.totalCritical).toBe(0);
    expect(report.totalWarning).toBe(0);
    expect(report.discrepancies).toEqual([]);
    expect(report.truncated).toEqual([]);
    expect(report.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // byKind tem todas as 6 entradas zeradas.
    expect(Object.keys(report.byKind).sort()).toEqual(
      Object.keys(KIND_LABELS).sort()
    );
    for (const count of Object.values(report.byKind)) {
      expect(count).toBe(0);
    }
  });

  it("é tolerante a erro num check individual (não propaga exceção)", async () => {
    // Enfileira erros — cada check loga e retorna vazio.
    for (let i = 0; i < 6; i++) {
      supa.enqueue("appointments", {
        data: null,
        error: { message: "db down" },
      });
      supa.enqueue("doctor_earnings", {
        data: null,
        error: { message: "db down" },
      });
      supa.enqueue("doctor_payouts", {
        data: null,
        error: { message: "db down" },
      });
    }

    // Os erros são despachados via logger canônico (PR-039), que é silencioso
    // em test por default. O ponto do teste é "não propaga exceção" + "report
    // vazio" — a instrumentação de logs é coberta em logger.test.ts.
    const report = await runReconciliation();

    expect(report).toBeDefined();
    expect(report.totalCritical).toBe(0);
    expect(report.totalWarning).toBe(0);
  });
});

describe("getReconciliationCounts", () => {
  it("retorna só os contadores sem vazar detalhes", async () => {
    // Prepara o mesmo cenário vazio do teste anterior.
    for (let i = 0; i < 6; i++) {
      supa.enqueue("appointments", { data: [], error: null });
      supa.enqueue("doctor_earnings", { data: [], error: null });
      supa.enqueue("doctor_payouts", { data: [], error: null });
    }

    const counts = await getReconciliationCounts();

    // Shape exato: só duas chaves.
    expect(Object.keys(counts).sort()).toEqual([
      "totalCritical",
      "totalWarning",
    ]);
    expect(counts.totalCritical).toBe(0);
    expect(counts.totalWarning).toBe(0);
  });
});
