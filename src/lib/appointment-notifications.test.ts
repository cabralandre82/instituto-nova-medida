/**
 * src/lib/appointment-notifications.test.ts — PR-067 · D-075 · finding 17.7
 *
 * Testa:
 *   1. `replaceVars` — substituição de placeholders {{N}}.
 *   2. `normalizePhoneDigits` — limpeza/validação de telefone.
 *   3. `maskPhoneForAdmin` — mascaramento forense.
 *   4. `renderNotificationBody` — pra cada kind, verifica template correto
 *      + variáveis substituídas + templateName correto + telefone normalizado.
 *   5. `recordBodySnapshot` — idempotência, guard `sent_at IS NULL`,
 *      distinção not_found vs already-sent, validação de input.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  replaceVars,
  normalizePhoneDigits,
  maskPhoneForAdmin,
  renderNotificationBody,
  recordBodySnapshot,
  type RenderContext,
} from "./appointment-notifications";
import type { NotificationKind } from "./wa-templates";

// ─── replaceVars ────────────────────────────────────────────────────────

describe("replaceVars", () => {
  it("substitui placeholders 1-indexed", () => {
    expect(replaceVars("Olá {{1}}, hoje é {{2}}.", ["Maria", "terça"])).toBe(
      "Olá Maria, hoje é terça."
    );
  });

  it("substitui por string vazia quando var faltante", () => {
    expect(replaceVars("A {{1}} B {{2}} C {{3}}", ["x"])).toBe("A x B  C ");
  });

  it("idempotente em placeholders repetidos", () => {
    expect(replaceVars("{{1}} e {{1}}", ["eco"])).toBe("eco e eco");
  });

  it("ignora {{0}} e {{-1}}", () => {
    expect(replaceVars("{{0}} ok {{1}}", ["X"])).toBe(" ok X");
  });

  it("não toca texto sem placeholder", () => {
    expect(replaceVars("texto fixo", ["ignorado"])).toBe("texto fixo");
  });
});

// ─── normalizePhoneDigits ───────────────────────────────────────────────

describe("normalizePhoneDigits", () => {
  it("remove máscara e caracteres não-dígito", () => {
    expect(normalizePhoneDigits("+55 (11) 98765-4321")).toBe("5511987654321");
    expect(normalizePhoneDigits("55 11 9 8765 4321")).toBe("5511987654321");
  });

  it("retorna vazio pra entrada curta ou longa demais", () => {
    expect(normalizePhoneDigits("")).toBe("");
    expect(normalizePhoneDigits("123")).toBe("");
    expect(normalizePhoneDigits("1".repeat(20))).toBe("");
  });

  it("retorna vazio pra input não-string", () => {
    expect(normalizePhoneDigits(null)).toBe("");
    expect(normalizePhoneDigits(undefined)).toBe("");
  });
});

// ─── maskPhoneForAdmin ──────────────────────────────────────────────────

describe("maskPhoneForAdmin", () => {
  it("mantém DDI+DDD e últimos 4 dígitos em E.164 brasileiro", () => {
    expect(maskPhoneForAdmin("+55 11 98765-4321")).toBe("+55 11 *****4321");
  });

  it("aceita dígito puro", () => {
    expect(maskPhoneForAdmin("5511987654321")).toBe("+55 11 *****4321");
  });

  it("retorna — para nulo", () => {
    expect(maskPhoneForAdmin(null)).toBe("—");
    expect(maskPhoneForAdmin(undefined)).toBe("—");
    expect(maskPhoneForAdmin("")).toBe("—");
  });

  it("retorna **** pra input inválido/curto", () => {
    expect(maskPhoneForAdmin("abc")).toBe("****");
    expect(maskPhoneForAdmin("123")).toBe("****");
  });

  it("aceita visible custom dentro do limite", () => {
    expect(maskPhoneForAdmin("5511987654321", { visible: 2 })).toBe(
      "+55 11 *******21"
    );
    expect(maskPhoneForAdmin("5511987654321", { visible: 6 })).toBe(
      "+55 11 ***654321"
    );
  });

  it("visible é clampada em [0, 6]", () => {
    const r10 = maskPhoneForAdmin("5511987654321", { visible: 100 });
    expect(r10.endsWith("654321")).toBe(true);
    const r0 = maskPhoneForAdmin("5511987654321", { visible: 0 });
    expect(r0).toMatch(/^\+55 11 \*+$/);
  });

  it("telefone de 10 dígitos (sem 9º dígito móvel) usa fallback sem DDI", () => {
    // 10 dígitos é válido (fixo BR). Cai no ramo "< 12 dígitos".
    const result = maskPhoneForAdmin("1133334444");
    expect(result).toMatch(/4444$/);
    expect(result.includes("*")).toBe(true);
  });
});

// ─── renderNotificationBody ─────────────────────────────────────────────

function makeCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    customerName: "Maria da Silva",
    customerPhone: "+55 11 98765-4321",
    doctorDisplay: "Dra. Joana Silva",
    scheduledAt: new Date("2026-05-22T17:00:00Z"), // 14h00 BRT
    consultaUrl: "https://institutonovamedida.com.br/consulta/abc-123",
    salaValidaAte: new Date("2026-05-22T17:30:00Z"),
    reagendamentoUrl: "https://institutonovamedida.com.br/c/abc123",
    baseUrl: "https://institutonovamedida.com.br",
    payload: null,
    ...overrides,
  };
}

describe("renderNotificationBody — confirmacao", () => {
  it("substitui nome, data/hora, médica, URL", () => {
    const r = renderNotificationBody("confirmacao", makeCtx());
    expect(r.templateName).toBe("confirmacao_agendamento");
    expect(r.targetPhone).toBe("5511987654321");
    expect(r.body).toContain("Olá, Maria!");
    expect(r.body).toContain("Dra. Joana Silva");
    expect(r.body).toContain("https://institutonovamedida.com.br/c/abc123");
    expect(r.body).toMatch(/14h00/);
  });

  it("primeiro nome capitaliza corretamente", () => {
    const r = renderNotificationBody(
      "confirmacao",
      makeCtx({ customerName: "maria aparecida souza" })
    );
    expect(r.body).toContain("Olá, Maria!");
  });
});

describe("renderNotificationBody — t_minus_24h", () => {
  it("usa formato 'amanhã às ...'", () => {
    const r = renderNotificationBody("t_minus_24h", makeCtx());
    expect(r.templateName).toBe("lembrete_consulta_24h");
    expect(r.body).toMatch(/amanhã às 14h00/);
    expect(r.body).toContain("Dra. Joana Silva");
  });
});

describe("renderNotificationBody — t_minus_1h", () => {
  it("usa formato 'hoje às ...'", () => {
    const r = renderNotificationBody("t_minus_1h", makeCtx());
    expect(r.templateName).toBe("lembrete_consulta_1h");
    expect(r.body).toMatch(/hoje às 14h00/);
  });
});

describe("renderNotificationBody — t_minus_15min", () => {
  it("inclui consultaUrl e formatTime do fim da sala", () => {
    const r = renderNotificationBody("t_minus_15min", makeCtx());
    expect(r.templateName).toBe("link_sala_consulta");
    expect(r.body).toContain("https://institutonovamedida.com.br/consulta/abc-123");
    expect(r.body).toMatch(/14h30/);
  });

  it("fallback salaValidaAte = scheduled + 30min", () => {
    const ctx = makeCtx();
    delete (ctx as Partial<RenderContext>).salaValidaAte;
    const r = renderNotificationBody("t_minus_15min", ctx as RenderContext);
    expect(r.body).toMatch(/14h30/); // 14h00 + 30min
  });
});

describe("renderNotificationBody — pos_consulta / t_plus_10min", () => {
  it("usa payload.receita_url e conduta_resumo", () => {
    const r = renderNotificationBody(
      "pos_consulta",
      makeCtx({
        payload: {
          receita_url: "https://memed.com.br/r/xyz",
          conduta_resumo: "Iniciar Tirzepatida 2.5mg semanal",
        },
      })
    );
    expect(r.templateName).toBe("pos_consulta_resumo");
    expect(r.body).toContain("https://memed.com.br/r/xyz");
    expect(r.body).toContain("Iniciar Tirzepatida 2.5mg semanal");
  });

  it("fallback para consultaUrl quando payload vazio", () => {
    const r = renderNotificationBody("pos_consulta", makeCtx());
    expect(r.body).toContain(
      "https://institutonovamedida.com.br/consulta/abc-123"
    );
    expect(r.body).toContain("Sua médica registrou a conduta");
  });

  it("t_plus_10min compartilha template pos_consulta_resumo", () => {
    const r = renderNotificationBody("t_plus_10min", makeCtx());
    expect(r.templateName).toBe("pos_consulta_resumo");
    expect(r.body).toContain("receita digital");
  });
});

describe("renderNotificationBody — reserva_expirada", () => {
  it("usa payload plano_nome e invoice_url", () => {
    const r = renderNotificationBody(
      "reserva_expirada",
      makeCtx({
        payload: {
          plano_nome: "Avançado",
          invoice_url: "https://www.asaas.com/i/abc123",
        },
      })
    );
    expect(r.templateName).toBe("pagamento_pix_pendente");
    expect(r.body).toContain("plano Avançado");
    expect(r.body).toContain("https://www.asaas.com/i/abc123");
  });

  it("fallback plano_nome='seu plano' e invoice=/planos", () => {
    const r = renderNotificationBody("reserva_expirada", makeCtx());
    expect(r.body).toContain("plano seu plano");
    expect(r.body).toContain("https://institutonovamedida.com.br/planos");
  });
});

describe("renderNotificationBody — on_demand_call", () => {
  it("renderiza fila on-demand", () => {
    const r = renderNotificationBody("on_demand_call", makeCtx());
    expect(r.templateName).toBe("vez_chegou_on_demand");
    expect(r.body).toContain("Maria, é a sua vez!");
    expect(r.body).toContain("A Dra. Joana Silva");
    expect(r.body).toContain("https://institutonovamedida.com.br/consulta/abc-123");
  });
});

describe("renderNotificationBody — no_show kinds", () => {
  it("no_show_patient inclui reagendamento", () => {
    const r = renderNotificationBody("no_show_patient", makeCtx());
    expect(r.templateName).toBe("no_show_patient_aviso");
    expect(r.body).toMatch(/sentiu sua falta hoje/i);
    expect(r.body).toContain("https://institutonovamedida.com.br/c/abc123");
  });

  it("no_show_doctor pede desculpas + reembolso", () => {
    const r = renderNotificationBody("no_show_doctor", makeCtx());
    expect(r.templateName).toBe("no_show_doctor_desculpas");
    expect(r.body).toMatch(/pedimos desculpas/i);
    expect(r.body).toMatch(/reembolso/i);
  });
});

describe("renderNotificationBody — targetPhone normalização", () => {
  it("remove máscara do telefone", () => {
    const r = renderNotificationBody(
      "t_minus_1h",
      makeCtx({ customerPhone: "(11) 98765-4321" })
    );
    expect(r.targetPhone).toBe("11987654321");
  });

  it("telefone inválido vira string vazia (não quebra render)", () => {
    const r = renderNotificationBody(
      "t_minus_1h",
      makeCtx({ customerPhone: "123" })
    );
    expect(r.targetPhone).toBe("");
    expect(r.body.length).toBeGreaterThan(0);
  });
});

describe("renderNotificationBody — exaustividade de kinds", () => {
  const kinds: NotificationKind[] = [
    "confirmacao",
    "t_minus_24h",
    "t_minus_1h",
    "t_minus_15min",
    "on_demand_call",
    "pos_consulta",
    "t_plus_10min",
    "reserva_expirada",
    "no_show_patient",
    "no_show_doctor",
  ];

  it.each(kinds)("kind=%s renderiza body não-vazio com templateName setado", (kind) => {
    const r = renderNotificationBody(kind, makeCtx());
    expect(r.body.length).toBeGreaterThan(30);
    expect(r.templateName.length).toBeGreaterThan(0);
    expect(r.body).not.toMatch(/\{\{\d+\}\}/); // nenhum placeholder não-substituído
  });
});

// ─── recordBodySnapshot ─────────────────────────────────────────────────

/**
 * Stub encadeado mínimo pra `appointment_notifications`.
 * Step 0: retorna `opts.update` (resultado do UPDATE ... .maybeSingle()).
 * Step 1+: retorna `opts.selectFallback` (resultado do SELECT re-read
 * quando UPDATE devolveu data=null sem error).
 */
function makeSupabaseStubSimple(opts: {
  /** Retorno do UPDATE principal. Null → "sem row atualizada". */
  update: { data: { id: string } | null; error: { message: string } | null };
  /** Retorno do SELECT de fallback (apenas usado quando update retorna null sem erro). */
  selectFallback?: {
    data: { id: string; sent_at: string | null } | null;
    error: { message: string } | null;
  };
}) {
  let step = 0 as 0 | 1;
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => {
      if (step === 0) {
        step = 1;
        return opts.update;
      }
      return (
        opts.selectFallback ?? {
          data: null,
          error: { message: "fallback not provided" },
        }
      );
    }),
  };
  const supabase = {
    from: vi.fn(() => builder),
  } as unknown as SupabaseClient;
  return supabase;
}

describe("recordBodySnapshot — validação de input", () => {
  it("rejeita notificationId inválido", async () => {
    const stub = makeSupabaseStubSimple({
      update: { data: null, error: null },
    });
    for (const bad of ["", "   ", "abc"]) {
      const r = await recordBodySnapshot(stub, {
        notificationId: bad,
        body: "Olá Maria",
        targetPhone: "5511987654321",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("invalid_id");
    }
  });

  it("rejeita body vazio", async () => {
    const stub = makeSupabaseStubSimple({ update: { data: null, error: null } });
    for (const bad of ["", "   ", "\n\t"]) {
      const r = await recordBodySnapshot(stub, {
        notificationId: "abcdef12-3456-7890",
        body: bad,
        targetPhone: "5511987654321",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("invalid_body");
    }
  });

  it("aceita targetPhone vazio (evidência explícita)", async () => {
    const stub = makeSupabaseStubSimple({
      update: { data: { id: "n-1" }, error: null },
    });
    const r = await recordBodySnapshot(stub, {
      notificationId: "abcdef12-3456-7890",
      body: "Olá Maria",
      targetPhone: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe(true);
  });
});

describe("recordBodySnapshot — happy path", () => {
  it("grava body, target_phone, rendered_at", async () => {
    const stub = makeSupabaseStubSimple({
      update: { data: { id: "n-1" }, error: null },
    });
    const r = await recordBodySnapshot(stub, {
      notificationId: "abcdef12-3456-7890",
      body: "Olá Maria",
      targetPhone: "5511987654321",
      now: new Date("2026-05-11T12:00:00Z"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toBe(true);
      expect(r.alreadySent).toBe(false);
    }
  });
});

describe("recordBodySnapshot — idempotência via guard sent_at IS NULL", () => {
  it("linha já enviada: retorna alreadySent=true, updated=false", async () => {
    const stub = makeSupabaseStubSimple({
      update: { data: null, error: null }, // guard sent_at IS NULL não bateu
      selectFallback: {
        data: { id: "n-1", sent_at: "2026-05-10T23:59:59Z" },
        error: null,
      },
    });
    const r = await recordBodySnapshot(stub, {
      notificationId: "abcdef12-3456-7890",
      body: "Olá Maria",
      targetPhone: "5511987654321",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toBe(false);
      expect(r.alreadySent).toBe(true);
    }
  });

  it("linha inexistente: retorna not_found", async () => {
    const stub = makeSupabaseStubSimple({
      update: { data: null, error: null },
      selectFallback: { data: null, error: null },
    });
    const r = await recordBodySnapshot(stub, {
      notificationId: "abcdef12-3456-7890",
      body: "Olá Maria",
      targetPhone: "5511987654321",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not_found");
  });
});

describe("recordBodySnapshot — erros de DB", () => {
  it("update com error: retorna db_error", async () => {
    const stub = makeSupabaseStubSimple({
      update: { data: null, error: { message: "network" } },
    });
    const r = await recordBodySnapshot(stub, {
      notificationId: "abcdef12-3456-7890",
      body: "Olá Maria",
      targetPhone: "5511987654321",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("db_error");
  });

  it("select-fallback com error: retorna db_error", async () => {
    const stub = makeSupabaseStubSimple({
      update: { data: null, error: null },
      selectFallback: { data: null, error: { message: "timeout" } },
    });
    const r = await recordBodySnapshot(stub, {
      notificationId: "abcdef12-3456-7890",
      body: "Olá Maria",
      targetPhone: "5511987654321",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("db_error");
  });
});
