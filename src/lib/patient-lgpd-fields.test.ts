/**
 * Testes estruturais do allowlist LGPD (PR-016 · D-051).
 *
 * Objetivo: tornar explícitos os invariantes do allowlist, pra que
 * adicionar/remover colunas futuras force revisão.
 */

import { describe, it, expect } from "vitest";
import {
  APPOINTMENT_COLUMNS,
  APPOINTMENT_NOTIFICATION_COLUMNS,
  CUSTOMER_COLUMNS,
  FULFILLMENT_ADDRESS_CHANGE_COLUMNS,
  FULFILLMENT_COLUMNS,
  LGPD_EXPORT_ALLOWLIST,
  LGPD_EXPORT_FORBIDDEN_FIELDS,
  PAYMENT_COLUMNS,
  PLAN_ACCEPTANCE_COLUMNS,
  columnsList,
} from "./patient-lgpd-fields";

describe("columnsList", () => {
  it("concatena colunas com vírgula (sintaxe Supabase .select)", () => {
    expect(columnsList(["a", "b", "c"])).toBe("a,b,c");
  });

  it("lista vazia vira string vazia (caller deve garantir que não acontece)", () => {
    expect(columnsList([])).toBe("");
  });
});

describe("allowlist — invariantes", () => {
  it("nenhum array é vazio (cada tabela tem ao menos colunas identitárias)", () => {
    for (const [table, cols] of Object.entries(LGPD_EXPORT_ALLOWLIST)) {
      expect(cols.length, `${table} sem colunas allowlisted`).toBeGreaterThan(
        0
      );
    }
  });

  it("nenhum array contém duplicatas", () => {
    for (const [table, cols] of Object.entries(LGPD_EXPORT_ALLOWLIST)) {
      const unique = new Set(cols);
      expect(
        unique.size,
        `${table} tem colunas duplicadas: ${JSON.stringify(cols)}`
      ).toBe(cols.length);
    }
  });

  it("cada tabela com PII contém 'id' (pra linkar com outras tabelas)", () => {
    for (const [table, cols] of Object.entries(LGPD_EXPORT_ALLOWLIST)) {
      expect(cols, `${table} sem 'id'`).toContain("id");
    }
  });

  it("customers contém identificadores essenciais do titular", () => {
    expect(CUSTOMER_COLUMNS).toContain("name");
    expect(CUSTOMER_COLUMNS).toContain("email");
    expect(CUSTOMER_COLUMNS).toContain("cpf");
    expect(CUSTOMER_COLUMNS).toContain("phone");
  });

  it("appointments expõe prontuário ao titular (Art. 18, V LGPD e CFM 1.821)", () => {
    expect(APPOINTMENT_COLUMNS).toContain("anamnese");
    expect(APPOINTMENT_COLUMNS).toContain("hipotese");
    expect(APPOINTMENT_COLUMNS).toContain("conduta");
    expect(APPOINTMENT_COLUMNS).toContain("memed_prescription_url");
  });

  it("plan_acceptances expõe hash imutável e versão dos termos", () => {
    expect(PLAN_ACCEPTANCE_COLUMNS).toContain("acceptance_text");
    expect(PLAN_ACCEPTANCE_COLUMNS).toContain("acceptance_hash");
    expect(PLAN_ACCEPTANCE_COLUMNS).toContain("terms_version");
  });

  it("payments não inclui asaas_raw (evita vazar payload duplicado de vendor)", () => {
    expect(PAYMENT_COLUMNS).not.toContain("asaas_raw");
    expect(PAYMENT_COLUMNS).not.toContain("asaas_payment_id");
    expect(PAYMENT_COLUMNS).not.toContain("asaas_env");
  });

  it("fulfillments não inclui campos internos de auditoria (updated_by_user_id)", () => {
    expect(FULFILLMENT_COLUMNS).not.toContain("updated_by_user_id");
  });

  it("appointments NÃO inclui tokens de vídeo nem payload bruto do Daily", () => {
    expect(APPOINTMENT_COLUMNS).not.toContain("video_doctor_token");
    expect(APPOINTMENT_COLUMNS).not.toContain("video_patient_token");
    expect(APPOINTMENT_COLUMNS).not.toContain("daily_raw");
    expect(APPOINTMENT_COLUMNS).not.toContain("daily_room_id");
    expect(APPOINTMENT_COLUMNS).not.toContain("daily_meeting_session_id");
  });

  it("appointment_notifications NÃO inclui payload (stack/body bruto)", () => {
    expect(APPOINTMENT_NOTIFICATION_COLUMNS).not.toContain("payload");
    expect(APPOINTMENT_NOTIFICATION_COLUMNS).not.toContain("error");
  });

  it("fulfillment_address_changes NÃO inclui changed_by_user_id (auditoria do outro ator)", () => {
    expect(FULFILLMENT_ADDRESS_CHANGE_COLUMNS).not.toContain(
      "changed_by_user_id"
    );
  });

  it("nenhum campo proibido aparece em qualquer allowlist", () => {
    for (const forbidden of LGPD_EXPORT_FORBIDDEN_FIELDS) {
      for (const [table, cols] of Object.entries(LGPD_EXPORT_ALLOWLIST)) {
        expect(
          cols.includes(forbidden as never),
          `${table} vazou campo proibido "${forbidden}"`
        ).toBe(false);
      }
    }
  });
});
