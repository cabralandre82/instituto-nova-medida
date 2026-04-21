/**
 * src/lib/cron-dashboard.test.ts — cobertura da agregação pura.
 *
 * Todos os testes usam `now` injetado + linhas construídas à mão pra
 * determinismo. Fetch não é testado aqui (IO → integração).
 */

import { describe, expect, it } from "vitest";
import {
  buildCronDashboard,
  __test__,
  type CronRunRow,
} from "./cron-dashboard";

const { percentile, avg, dateKey, startOfUtcDay, STUCK_THRESHOLD_MS } =
  __test__;

/**
 * Âncora: 2026-04-21 12:00:00 UTC. Todos os tempos nos testes são
 * relativos a este `NOW` pra facilitar leitura.
 */
const NOW = new Date("2026-04-21T12:00:00.000Z").getTime();
const MS_DAY = 24 * 60 * 60 * 1000;
const MS_HOUR = 60 * 60 * 1000;

function row(overrides: Partial<CronRunRow> & Pick<CronRunRow, "job">): CronRunRow {
  return {
    id: overrides.id ?? cryptoIdLike(),
    job: overrides.job,
    started_at:
      overrides.started_at ?? new Date(NOW - 1 * MS_HOUR).toISOString(),
    finished_at:
      overrides.finished_at === undefined
        ? new Date(NOW - 1 * MS_HOUR + 500).toISOString()
        : overrides.finished_at,
    status: overrides.status ?? "ok",
    duration_ms: overrides.duration_ms === undefined ? 500 : overrides.duration_ms,
    error_message: overrides.error_message ?? null,
  };
}

let _idCounter = 0;
function cryptoIdLike(): string {
  _idCounter += 1;
  return `00000000-0000-0000-0000-${String(_idCounter).padStart(12, "0")}`;
}

describe("cron-dashboard · helpers", () => {
  it("percentile usa nearest-rank", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.5)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(
      100
    );
  });

  it("avg é arredondada e é null em lista vazia", () => {
    expect(avg([])).toBeNull();
    expect(avg([1, 2, 3])).toBe(2);
    expect(avg([500, 600, 700])).toBe(600);
  });

  it("dateKey formata UTC estável", () => {
    expect(dateKey(new Date("2026-04-21T23:59:00Z").getTime())).toBe(
      "2026-04-21"
    );
    expect(dateKey(new Date("2026-04-22T00:00:00Z").getTime())).toBe(
      "2026-04-22"
    );
  });

  it("startOfUtcDay zera HH:MM:SS", () => {
    const base = startOfUtcDay(NOW);
    expect(new Date(base).toISOString()).toBe("2026-04-21T00:00:00.000Z");
  });

  it("STUCK_THRESHOLD_MS é 2h", () => {
    expect(STUCK_THRESHOLD_MS).toBe(2 * MS_HOUR);
  });
});

describe("cron-dashboard · buildCronDashboard · casos base", () => {
  it("report vazio quando não há runs nem expectedJobs", () => {
    const report = buildCronDashboard([], { windowDays: 30, now: NOW });
    expect(report.overall.total_runs).toBe(0);
    expect(report.overall.success_rate).toBeNull();
    expect(report.jobs).toHaveLength(0);
  });

  it("expectedJobs cria entries zeradas mesmo sem runs", () => {
    const report = buildCronDashboard([], {
      windowDays: 30,
      now: NOW,
      expectedJobs: ["admin_digest", "retention_anonymize"],
    });

    expect(report.jobs).toHaveLength(2);
    for (const j of report.jobs) {
      expect(j.total_runs).toBe(0);
      expect(j.ok_count).toBe(0);
      expect(j.error_count).toBe(0);
      expect(j.running_count).toBe(0);
      expect(j.success_rate).toBeNull();
      expect(j.last_run).toBeNull();
      expect(j.last_error_at).toBeNull();
      expect(j.daily).toHaveLength(30);
    }
  });

  it("buckets diários sempre têm windowDays entradas (inclusive dias vazios)", () => {
    const report = buildCronDashboard(
      [row({ job: "admin_digest", started_at: new Date(NOW - 1 * MS_HOUR).toISOString() })],
      { windowDays: 7, now: NOW }
    );
    const job = report.jobs[0];
    expect(job.daily).toHaveLength(7);
    // dates devem ir de NOW-6d até NOW
    const first = job.daily[0].date;
    const last = job.daily[job.daily.length - 1].date;
    expect(first).toBe("2026-04-15");
    expect(last).toBe("2026-04-21");
  });
});

describe("cron-dashboard · contagens e success rate", () => {
  it("conta ok/error/running corretamente", () => {
    const rows: CronRunRow[] = [
      row({ job: "admin_digest", status: "ok", duration_ms: 400 }),
      row({ job: "admin_digest", status: "ok", duration_ms: 500 }),
      row({
        job: "admin_digest",
        status: "error",
        duration_ms: 1000,
        error_message: "boom",
      }),
      row({ job: "admin_digest", status: "running", duration_ms: null, finished_at: null }),
    ];

    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    const j = report.jobs[0];

    expect(j.total_runs).toBe(4);
    expect(j.ok_count).toBe(2);
    expect(j.error_count).toBe(1);
    expect(j.running_count).toBe(1);
    // success_rate: 2 ok em 3 concluídos = 0.666...
    expect(j.success_rate).toBeCloseTo(2 / 3, 4);
  });

  it("running não conta em avg/p50/p95", () => {
    const rows: CronRunRow[] = [
      row({ job: "x", status: "ok", duration_ms: 100 }),
      row({ job: "x", status: "ok", duration_ms: 200 }),
      row({ job: "x", status: "ok", duration_ms: 300 }),
      row({
        job: "x",
        status: "running",
        duration_ms: null,
        finished_at: null,
        started_at: new Date(NOW - 10 * MS_HOUR).toISOString(),
      }),
    ];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    const j = report.jobs[0];
    expect(j.duration.avg_ms).toBe(200);
    expect(j.duration.p50_ms).toBe(200);
    expect(j.duration.p95_ms).toBe(300);
    expect(j.duration.max_ms).toBe(300);
  });

  it("success_rate é null quando não há runs concluídos", () => {
    const report = buildCronDashboard(
      [
        row({
          job: "x",
          status: "running",
          duration_ms: null,
          finished_at: null,
        }),
      ],
      { windowDays: 30, now: NOW }
    );
    expect(report.jobs[0].success_rate).toBeNull();
  });
});

describe("cron-dashboard · stuck runs", () => {
  it("detecta running há mais de 2h como stuck", () => {
    const rows: CronRunRow[] = [
      row({
        job: "x",
        status: "running",
        duration_ms: null,
        finished_at: null,
        started_at: new Date(NOW - 3 * MS_HOUR).toISOString(),
      }),
      row({
        job: "x",
        status: "running",
        duration_ms: null,
        finished_at: null,
        started_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
      }),
    ];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    const j = report.jobs[0];
    expect(j.running_count).toBe(2);
    expect(j.stuck_count).toBe(1);
    expect(report.overall.stuck_count).toBe(1);
  });
});

describe("cron-dashboard · week_delta", () => {
  it("calcula delta de success_rate em pontos percentuais", () => {
    const rows: CronRunRow[] = [
      // Semana atual: 8 ok / 2 error = 80%
      ...Array.from({ length: 8 }, (_, i) =>
        row({
          job: "x",
          status: "ok",
          started_at: new Date(NOW - (i + 1) * MS_HOUR).toISOString(),
        })
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        row({
          job: "x",
          status: "error",
          error_message: "e",
          started_at: new Date(NOW - (i + 20) * MS_HOUR).toISOString(),
        })
      ),
      // Semana anterior: 9 ok / 1 error = 90%
      ...Array.from({ length: 9 }, (_, i) =>
        row({
          job: "x",
          status: "ok",
          started_at: new Date(
            NOW - 7 * MS_DAY - (i + 1) * MS_HOUR
          ).toISOString(),
        })
      ),
      row({
        job: "x",
        status: "error",
        error_message: "e",
        started_at: new Date(NOW - 10 * MS_DAY).toISOString(),
      }),
    ];

    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    const j = report.jobs[0];
    expect(j.week_delta.current.total).toBe(10);
    expect(j.week_delta.current.success_rate).toBeCloseTo(0.8, 2);
    expect(j.week_delta.previous.total).toBe(10);
    expect(j.week_delta.previous.success_rate).toBeCloseTo(0.9, 2);
    // 80% - 90% = -10 pp
    expect(j.week_delta.success_rate_delta_pp).toBe(-10);
  });

  it("delta é null se alguma janela está vazia", () => {
    const rows: CronRunRow[] = [
      row({
        job: "x",
        status: "ok",
        started_at: new Date(NOW - 2 * MS_HOUR).toISOString(),
      }),
    ];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    expect(report.jobs[0].week_delta.previous.total).toBe(0);
    expect(report.jobs[0].week_delta.success_rate_delta_pp).toBeNull();
  });
});

describe("cron-dashboard · last_run e last_error", () => {
  it("last_run é o mais recente independente de status", () => {
    const rows: CronRunRow[] = [
      row({
        job: "x",
        status: "ok",
        started_at: new Date(NOW - 10 * MS_HOUR).toISOString(),
        id: "older",
      }),
      row({
        job: "x",
        status: "error",
        error_message: "later",
        started_at: new Date(NOW - 1 * MS_HOUR).toISOString(),
        id: "newer",
      }),
    ];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    expect(report.jobs[0].last_run?.id).toBe("newer");
    expect(report.jobs[0].last_error_message).toBe("later");
  });

  it("last_error_at fica null se nunca houve erro", () => {
    const rows: CronRunRow[] = [row({ job: "x", status: "ok" })];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    expect(report.jobs[0].last_error_at).toBeNull();
    expect(report.jobs[0].last_error_message).toBeNull();
  });
});

describe("cron-dashboard · ordenação e limites", () => {
  it("jobs com erro recente aparecem primeiro", () => {
    const rows: CronRunRow[] = [
      // "healthy" — só ok
      row({ job: "healthy", status: "ok" }),
      row({ job: "healthy", status: "ok" }),
      // "broken" — só 1 run, mas com erro
      row({ job: "broken", status: "error", error_message: "bad" }),
    ];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    expect(report.jobs[0].job).toBe("broken");
    expect(report.jobs[1].job).toBe("healthy");
  });

  it("recent_runs limita a 20 entradas, mais recente primeiro", () => {
    const rows: CronRunRow[] = Array.from({ length: 30 }, (_, i) =>
      row({
        job: "x",
        started_at: new Date(NOW - i * MS_HOUR).toISOString(),
        id: `run-${i}`,
      })
    );
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    const j = report.jobs[0];
    expect(j.recent_runs).toHaveLength(20);
    expect(j.recent_runs[0].id).toBe("run-0"); // mais recente
    expect(j.recent_runs[19].id).toBe("run-19");
  });

  it("runs fora da janela são descartados", () => {
    const rows: CronRunRow[] = [
      row({
        job: "x",
        status: "ok",
        started_at: new Date(NOW - 100 * MS_DAY).toISOString(),
      }),
      row({
        job: "x",
        status: "ok",
        started_at: new Date(NOW - 1 * MS_HOUR).toISOString(),
      }),
    ];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    expect(report.jobs[0].total_runs).toBe(1);
  });
});

describe("cron-dashboard · overall", () => {
  it("agrega contadores de todos os jobs", () => {
    const rows: CronRunRow[] = [
      row({ job: "a", status: "ok" }),
      row({ job: "a", status: "error", error_message: "e" }),
      row({ job: "b", status: "ok" }),
      row({ job: "b", status: "ok" }),
    ];
    const report = buildCronDashboard(rows, { windowDays: 30, now: NOW });
    expect(report.overall.total_runs).toBe(4);
    expect(report.overall.ok_count).toBe(3);
    expect(report.overall.error_count).toBe(1);
    expect(report.overall.distinct_jobs).toBe(2);
    expect(report.overall.success_rate).toBeCloseTo(0.75, 4);
  });
});
