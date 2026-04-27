/**
 * Testes de doctor-presence — PR-075-B · D-087.
 *
 * Foco: contrato do `sweepStalePresence` (caminho feliz, dryRun,
 * erro de SELECT/UPDATE, clamp de limit). Os helpers `recordHeartbeat`
 * e `setPresenceStatus` são wrappers de RPC, cobertos por contrato
 * de tipos + smoke do RPC na própria migration. As constantes
 * exportadas (thresholds e limits) têm asserções defensivas pra
 * pegar regressão acidental.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_STALE_SWEEP_LIMIT,
  MAX_STALE_SWEEP_LIMIT,
  MIN_STALE_SWEEP_LIMIT,
  PRESENCE_HEARTBEAT_INTERVAL_SECONDS,
  STALE_PRESENCE_THRESHOLD_SECONDS,
  sweepStalePresence,
} from "./doctor-presence";

const NOW = new Date("2026-05-21T12:00:00.000Z");
const NOW_MS = NOW.getTime();

// Fora da janela default (120s) — claramente stale.
const STALE_AT = new Date(NOW_MS - 200 * 1000).toISOString();
const VERY_STALE_AT = new Date(NOW_MS - 600 * 1000).toISOString();

type Candidate = { doctor_id: string; last_heartbeat_at: string };

// ───────────────────────────────────────────────────────────────────
// Stub mínimo do supabase pro padrão SELECT→UPDATE do sweep.
// Espelha makeSweepClient de appointment-credits.test.ts.
// ───────────────────────────────────────────────────────────────────

function makeSweepClient(opts: {
  candidates?: Candidate[];
  selectError?: { message: string };
  updatedDoctorIds?: string[];
  updateError?: { message: string };
  onSelect?: (params: { lt: string; limit: number }) => void;
  onUpdate?: (params: {
    payload: Record<string, unknown>;
    ids: string[];
  }) => void;
}) {
  const candidates = opts.candidates ?? [];
  const updatedDoctorIds =
    opts.updatedDoctorIds ?? candidates.map((c) => c.doctor_id);

  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            in(_col: string, _statuses: string[]) {
              return {
                lt(_col2: string, ltVal: string) {
                  return {
                    order(_col3: string, _opts: unknown) {
                      return {
                        limit: (limit: number) => {
                          opts.onSelect?.({ lt: ltVal, limit });
                          return Promise.resolve({
                            data: opts.selectError ? null : candidates,
                            error: opts.selectError ?? null,
                          });
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          return {
            in(_col: string, ids: string[]) {
              return {
                in(_col2: string, _statuses: string[]) {
                  return {
                    select: (_cols: string) => {
                      opts.onUpdate?.({ payload, ids });
                      if (opts.updateError) {
                        return Promise.resolve({
                          data: null,
                          error: opts.updateError,
                        });
                      }
                      return Promise.resolve({
                        data: updatedDoctorIds.map((id) => ({
                          doctor_id: id,
                        })),
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Constantes
// ───────────────────────────────────────────────────────────────────

describe("doctor-presence · constantes", () => {
  it("STALE_PRESENCE_THRESHOLD_SECONDS é >= 4× heartbeat (tolera 2 pings perdidos)", () => {
    expect(STALE_PRESENCE_THRESHOLD_SECONDS).toBeGreaterThanOrEqual(
      PRESENCE_HEARTBEAT_INTERVAL_SECONDS * 3
    );
  });

  it("DEFAULT_STALE_SWEEP_LIMIT está dentro de [MIN, MAX]", () => {
    expect(DEFAULT_STALE_SWEEP_LIMIT).toBeGreaterThanOrEqual(
      MIN_STALE_SWEEP_LIMIT
    );
    expect(DEFAULT_STALE_SWEEP_LIMIT).toBeLessThanOrEqual(
      MAX_STALE_SWEEP_LIMIT
    );
  });

  it("MAX_STALE_SWEEP_LIMIT é finito e razoável (≤ 10k)", () => {
    expect(Number.isFinite(MAX_STALE_SWEEP_LIMIT)).toBe(true);
    expect(MAX_STALE_SWEEP_LIMIT).toBeLessThanOrEqual(10_000);
  });
});

// ───────────────────────────────────────────────────────────────────
// sweepStalePresence
// ───────────────────────────────────────────────────────────────────

describe("sweepStalePresence", () => {
  it("sem candidatos → report zerado e UPDATE não chamado", async () => {
    let updateCalled = false;
    const supa = makeSweepClient({
      candidates: [],
      onUpdate: () => {
        updateCalled = true;
      },
    });

    const r = await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
    });

    expect(r.candidatesFound).toBe(0);
    expect(r.forcedOffline).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.dryRun).toBe(false);
    expect(r.oldestStaleHeartbeatAt).toBeNull();
    expect(r.newestStaleHeartbeatAt).toBeNull();
    expect(updateCalled).toBe(false);
  });

  it("feliz: 3 candidatos → forcedOffline=3, oldest/newest preenchidos", async () => {
    const candidates: Candidate[] = [
      { doctor_id: "doc-a", last_heartbeat_at: VERY_STALE_AT },
      { doctor_id: "doc-b", last_heartbeat_at: STALE_AT },
      {
        doctor_id: "doc-c",
        last_heartbeat_at: new Date(NOW_MS - 130 * 1000).toISOString(),
      },
    ];

    let capturedSelect: { lt: string; limit: number } | null = null;
    let capturedUpdate: {
      payload: Record<string, unknown>;
      ids: string[];
    } | null = null;

    const supa = makeSweepClient({
      candidates,
      onSelect: (p) => {
        capturedSelect = p;
      },
      onUpdate: (p) => {
        capturedUpdate = p;
      },
    });

    const r = await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
    });

    expect(r.candidatesFound).toBe(3);
    expect(r.forcedOffline).toBe(3);
    expect(r.errors).toBe(0);
    expect(r.dryRun).toBe(false);
    expect(r.oldestStaleHeartbeatAt).toBe(VERY_STALE_AT);
    expect(r.newestStaleHeartbeatAt).toBe(
      new Date(NOW_MS - 130 * 1000).toISOString()
    );

    expect(capturedSelect).not.toBeNull();
    // cutoff = now - threshold*1000 = NOW - 120s
    expect(capturedSelect!.lt).toBe(
      new Date(NOW_MS - STALE_PRESENCE_THRESHOLD_SECONDS * 1000).toISOString()
    );
    expect(capturedSelect!.limit).toBe(DEFAULT_STALE_SWEEP_LIMIT);

    expect(capturedUpdate).not.toBeNull();
    expect(capturedUpdate!.ids).toEqual(["doc-a", "doc-b", "doc-c"]);
    expect(capturedUpdate!.payload.status).toBe("offline");
    expect(capturedUpdate!.payload.online_since).toBeNull();
    expect(capturedUpdate!.payload.source).toBe("auto_offline");
  });

  it("dryRun=true → reporta candidatos mas não chama UPDATE", async () => {
    let updateCalled = false;
    const supa = makeSweepClient({
      candidates: [{ doctor_id: "doc-a", last_heartbeat_at: STALE_AT }],
      onUpdate: () => {
        updateCalled = true;
      },
    });

    const r = await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
      dryRun: true,
    });

    expect(r.candidatesFound).toBe(1);
    expect(r.forcedOffline).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(r.oldestStaleHeartbeatAt).toBe(STALE_AT);
    expect(r.newestStaleHeartbeatAt).toBe(STALE_AT);
    expect(updateCalled).toBe(false);
  });

  it("erro no SELECT → errors=1, forcedOffline=0", async () => {
    const supa = makeSweepClient({
      selectError: { message: "boom-select" },
    });

    const r = await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
    });

    expect(r.errors).toBe(1);
    expect(r.forcedOffline).toBe(0);
    expect(r.errorDetails.some((d) => d.includes("boom-select"))).toBe(true);
  });

  it("erro no UPDATE → errors=1, forcedOffline=0", async () => {
    const supa = makeSweepClient({
      candidates: [{ doctor_id: "doc-a", last_heartbeat_at: STALE_AT }],
      updateError: { message: "boom-update" },
    });

    const r = await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
    });

    expect(r.candidatesFound).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.forcedOffline).toBe(0);
    expect(r.errorDetails.some((d) => d.includes("boom-update"))).toBe(true);
  });

  it("limit acima do MAX é clampado", async () => {
    let capturedLimit = -1;
    const supa = makeSweepClient({
      candidates: [],
      onSelect: (p) => {
        capturedLimit = p.limit;
      },
    });

    await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
      limit: 999_999,
    });

    expect(capturedLimit).toBe(MAX_STALE_SWEEP_LIMIT);
  });

  it("limit abaixo do MIN é clampado", async () => {
    let capturedLimit = -1;
    const supa = makeSweepClient({
      candidates: [],
      onSelect: (p) => {
        capturedLimit = p.limit;
      },
    });

    await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
      limit: -100,
    });

    expect(capturedLimit).toBe(MIN_STALE_SWEEP_LIMIT);
  });

  it("staleThresholdSeconds custom muda a janela de cutoff", async () => {
    let capturedLt: string | null = null;
    const supa = makeSweepClient({
      candidates: [],
      onSelect: (p) => {
        capturedLt = p.lt;
      },
    });

    await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
      staleThresholdSeconds: 60,
    });

    expect(capturedLt).toBe(new Date(NOW_MS - 60 * 1000).toISOString());
  });

  it("staleThresholdSeconds <= 0 cai no MIN (>=1s)", async () => {
    let capturedLt: string | null = null;
    const supa = makeSweepClient({
      candidates: [],
      onSelect: (p) => {
        capturedLt = p.lt;
      },
    });

    await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
      staleThresholdSeconds: 0,
    });

    expect(capturedLt).toBe(new Date(NOW_MS - 1 * 1000).toISOString());
  });

  it("UPDATE com 1 row mas a tabela responde com 0 → forcedOffline=0 (race)", async () => {
    // Simula a guarda anti-race do filtro WHERE status IN ('online','busy')
    // — médica fez toggle pra offline entre SELECT e UPDATE.
    const supa = makeSweepClient({
      candidates: [{ doctor_id: "doc-a", last_heartbeat_at: STALE_AT }],
      updatedDoctorIds: [],
    });

    const r = await sweepStalePresence(supa as unknown as SupabaseClient, {
      now: NOW,
    });

    expect(r.candidatesFound).toBe(1);
    expect(r.forcedOffline).toBe(0);
    expect(r.errors).toBe(0);
  });
});
