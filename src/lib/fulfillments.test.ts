/**
 * Testes unitários do domínio de fulfillment (D-044 · onda 2.A).
 *
 * Foco em:
 *   - Correção absoluta da máquina de estados (cada transição
 *     permitida/bloqueada está listada explicitamente).
 *   - Determinismo + robustez do hash de aceite (mesma entrada
 *     sempre gera mesmo hash; variações superficiais de whitespace
 *     ou Unicode não mudam o hash).
 */

import { describe, it, expect } from "vitest";
import {
  canTransition,
  computeAcceptanceHash,
  fulfillmentStatusLabel,
  isTerminalStatus,
  nextAllowedStatuses,
  timestampsForTransition,
  type FulfillmentStatus,
} from "./fulfillments";

const ALL_STATUSES: readonly FulfillmentStatus[] = [
  "pending_acceptance",
  "pending_payment",
  "paid",
  "pharmacy_requested",
  "shipped",
  "delivered",
  "cancelled",
];

// ────────────────────────────────────────────────────────────────────────
// Máquina de estados
// ────────────────────────────────────────────────────────────────────────

describe("canTransition", () => {
  it("permite as transições do caminho feliz em ordem", () => {
    const happyPath: Array<[FulfillmentStatus, FulfillmentStatus]> = [
      ["pending_acceptance", "pending_payment"],
      ["pending_payment", "paid"],
      ["paid", "pharmacy_requested"],
      ["pharmacy_requested", "shipped"],
      ["shipped", "delivered"],
    ];
    for (const [from, to] of happyPath) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("permite cancelar em qualquer etapa pré-delivered", () => {
    const cancelableFrom: FulfillmentStatus[] = [
      "pending_acceptance",
      "pending_payment",
      "paid",
      "pharmacy_requested",
      "shipped",
    ];
    for (const from of cancelableFrom) {
      expect(canTransition(from, "cancelled")).toBe(true);
    }
  });

  it("bloqueia transição a partir de estado terminal", () => {
    for (const to of ALL_STATUSES) {
      expect(canTransition("delivered", to)).toBe(false);
      expect(canTransition("cancelled", to)).toBe(false);
    }
  });

  it("rejeita auto-transição pra qualquer estado", () => {
    for (const s of ALL_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("rejeita pulo de etapas (ex: pending_acceptance → paid)", () => {
    expect(canTransition("pending_acceptance", "paid")).toBe(false);
    expect(canTransition("pending_acceptance", "shipped")).toBe(false);
    expect(canTransition("pending_payment", "shipped")).toBe(false);
    expect(canTransition("paid", "shipped")).toBe(false);
    expect(canTransition("paid", "delivered")).toBe(false);
    expect(canTransition("pharmacy_requested", "delivered")).toBe(false);
  });

  it("rejeita retrocesso (ex: paid → pending_payment)", () => {
    expect(canTransition("paid", "pending_payment")).toBe(false);
    expect(canTransition("shipped", "paid")).toBe(false);
    expect(canTransition("delivered", "shipped")).toBe(false);
  });

  it("rejeita reviver estados terminais", () => {
    expect(canTransition("cancelled", "pending_acceptance")).toBe(false);
    expect(canTransition("delivered", "pending_acceptance")).toBe(false);
  });
});

describe("nextAllowedStatuses", () => {
  it("retorna 2 opções (avançar ou cancelar) nos estados intermediários", () => {
    expect(nextAllowedStatuses("pending_acceptance")).toEqual([
      "pending_payment",
      "cancelled",
    ]);
    expect(nextAllowedStatuses("pending_payment")).toEqual([
      "paid",
      "cancelled",
    ]);
    expect(nextAllowedStatuses("paid")).toEqual([
      "pharmacy_requested",
      "cancelled",
    ]);
    expect(nextAllowedStatuses("pharmacy_requested")).toEqual([
      "shipped",
      "cancelled",
    ]);
    expect(nextAllowedStatuses("shipped")).toEqual(["delivered", "cancelled"]);
  });

  it("retorna vazio em estados terminais", () => {
    expect(nextAllowedStatuses("delivered")).toEqual([]);
    expect(nextAllowedStatuses("cancelled")).toEqual([]);
  });
});

describe("isTerminalStatus", () => {
  it("marca delivered e cancelled como terminais; o resto não", () => {
    expect(isTerminalStatus("delivered")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);

    expect(isTerminalStatus("pending_acceptance")).toBe(false);
    expect(isTerminalStatus("pending_payment")).toBe(false);
    expect(isTerminalStatus("paid")).toBe(false);
    expect(isTerminalStatus("pharmacy_requested")).toBe(false);
    expect(isTerminalStatus("shipped")).toBe(false);
  });
});

describe("fulfillmentStatusLabel", () => {
  it("retorna string não-vazia para todos os estados", () => {
    for (const s of ALL_STATUSES) {
      const label = fulfillmentStatusLabel(s);
      expect(label).toBeTruthy();
      expect(label.length).toBeGreaterThan(3);
    }
  });

  it("usa rótulos distintos para cada estado (sem duplicatas)", () => {
    const labels = new Set(ALL_STATUSES.map(fulfillmentStatusLabel));
    expect(labels.size).toBe(ALL_STATUSES.length);
  });
});

describe("timestampsForTransition", () => {
  const fixedDate = new Date("2026-04-20T12:00:00Z");

  it("define o timestamp correspondente em cada destino não terminal inicial", () => {
    expect(
      timestampsForTransition("pending_payment", fixedDate).accepted_at
    ).toBe(fixedDate.toISOString());
    expect(timestampsForTransition("paid", fixedDate).paid_at).toBe(
      fixedDate.toISOString()
    );
    expect(
      timestampsForTransition("pharmacy_requested", fixedDate)
        .pharmacy_requested_at
    ).toBe(fixedDate.toISOString());
    expect(timestampsForTransition("shipped", fixedDate).shipped_at).toBe(
      fixedDate.toISOString()
    );
    expect(timestampsForTransition("delivered", fixedDate).delivered_at).toBe(
      fixedDate.toISOString()
    );
    expect(timestampsForTransition("cancelled", fixedDate).cancelled_at).toBe(
      fixedDate.toISOString()
    );
  });

  it("retorna objeto vazio para pending_acceptance (estado inicial)", () => {
    expect(timestampsForTransition("pending_acceptance", fixedDate)).toEqual(
      {}
    );
  });

  it("não contamina campos de transições anteriores", () => {
    const patch = timestampsForTransition("shipped", fixedDate);
    expect(patch.paid_at).toBeUndefined();
    expect(patch.pharmacy_requested_at).toBeUndefined();
    expect(patch.delivered_at).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Hash de aceite
// ────────────────────────────────────────────────────────────────────────

describe("computeAcceptanceHash", () => {
  const baseInput = {
    acceptanceText:
      "Declaro que li a prescrição da Dra. Joana e aceito contratar o plano Tirzepatida 90 dias.",
    planSlug: "tirzepatida-90",
    prescriptionUrl: "https://memed.com.br/prescription/abc-123",
    appointmentId: "11111111-1111-1111-1111-111111111111",
  };

  it("produz sempre o mesmo hash para a mesma entrada", () => {
    const h1 = computeAcceptanceHash(baseInput);
    const h2 = computeAcceptanceHash(baseInput);
    expect(h1).toBe(h2);
  });

  it("produz hash em formato sha256 hex (64 chars)", () => {
    const h = computeAcceptanceHash(baseInput);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("muda o hash se o texto mudar (ainda que pouco)", () => {
    const base = computeAcceptanceHash(baseInput);
    const other = computeAcceptanceHash({
      ...baseInput,
      acceptanceText: baseInput.acceptanceText + " (v2)",
    });
    expect(base).not.toBe(other);
  });

  it("muda o hash se o plano mudar", () => {
    const base = computeAcceptanceHash(baseInput);
    const other = computeAcceptanceHash({
      ...baseInput,
      planSlug: "tirzepatida-180",
    });
    expect(base).not.toBe(other);
  });

  it("muda o hash se a prescrição mudar", () => {
    const base = computeAcceptanceHash(baseInput);
    const other = computeAcceptanceHash({
      ...baseInput,
      prescriptionUrl: baseInput.prescriptionUrl + "?v=2",
    });
    expect(base).not.toBe(other);
  });

  it("muda o hash se o appointment mudar (evita reuso em outra consulta)", () => {
    const base = computeAcceptanceHash(baseInput);
    const other = computeAcceptanceHash({
      ...baseInput,
      appointmentId: "22222222-2222-2222-2222-222222222222",
    });
    expect(base).not.toBe(other);
  });

  it("é resiliente a whitespace extra no texto (colapsa em 1 espaço)", () => {
    const base = computeAcceptanceHash(baseInput);
    const noisy = computeAcceptanceHash({
      ...baseInput,
      acceptanceText: `  ${baseInput.acceptanceText.replace(/ /g, "   ")}  `,
    });
    expect(base).toBe(noisy);
  });

  it("é resiliente a case diferente no slug do plano", () => {
    const base = computeAcceptanceHash(baseInput);
    const upper = computeAcceptanceHash({
      ...baseInput,
      planSlug: baseInput.planSlug.toUpperCase(),
    });
    expect(base).toBe(upper);
  });

  it("normaliza Unicode NFC (acentos decompostos vs. compostos)", () => {
    // "consulta" → caso simples; usa "á" decomposto vs. composto
    const composed = computeAcceptanceHash({
      ...baseInput,
      acceptanceText: "á",
    });
    const decomposed = computeAcceptanceHash({
      ...baseInput,
      acceptanceText: "a\u0301",
    });
    expect(composed).toBe(decomposed);
  });
});
