/**
 * Testes dos helpers de billing-documents (D-041).
 */

import { describe, it, expect } from "vitest";
import {
  ALLOWED_MIMES,
  BUCKET,
  MAX_UPLOAD_BYTES,
  buildStoragePath,
  isStoragePath,
  slugifyFilename,
} from "./billing-documents";

describe("isStoragePath", () => {
  it("reconhece paths do bucket (começam com billing/)", () => {
    expect(isStoragePath("billing/abc/timestamp-doc.pdf")).toBe(true);
  });
  it("rejeita URLs externas", () => {
    expect(isStoragePath("https://cdn.example/x.pdf")).toBe(false);
  });
  it("rejeita vazio/null", () => {
    expect(isStoragePath(null)).toBe(false);
    expect(isStoragePath(undefined)).toBe(false);
    expect(isStoragePath("")).toBe(false);
  });
  it("rejeita paths de outros buckets (ex: payouts/)", () => {
    expect(isStoragePath("payouts/abc/doc.pdf")).toBe(false);
  });
});

describe("slugifyFilename", () => {
  it("remove acentos e normaliza pra minúsculo", () => {
    expect(slugifyFilename("Notação Fiscal.pdf")).toBe("notacao-fiscal");
  });
  it("troca caracteres especiais por hífen", () => {
    expect(slugifyFilename("NF_123/SP.xml")).toBe("nf-123-sp");
  });
  it("limita tamanho a 40 chars", () => {
    const long = "a".repeat(100);
    expect(slugifyFilename(long)).toHaveLength(40);
  });
  it("nunca retorna vazio", () => {
    expect(slugifyFilename("?????")).toBe("nota-fiscal");
    expect(slugifyFilename(".pdf")).toBe("nota-fiscal");
  });
});

describe("buildStoragePath", () => {
  it("monta path determinístico com payout, timestamp e extensão do mime", () => {
    const path = buildStoragePath({
      payoutId: "payout-1",
      originalName: "Nota.pdf",
      mime: "application/pdf",
      now: new Date("2026-04-20T15:30:45.123Z"),
    });
    expect(path).toMatch(/^billing\/payout-1\/[0-9T-]+-nota\.pdf$/);
    expect(path).toContain("payout-1");
    expect(path.endsWith(".pdf")).toBe(true);
  });

  it("usa extensão xml pra application/xml e text/xml", () => {
    const p1 = buildStoragePath({
      payoutId: "p1",
      originalName: "nf.xml",
      mime: "application/xml",
      now: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(p1).toMatch(/\.xml$/);
    const p2 = buildStoragePath({
      payoutId: "p1",
      originalName: "nf.xml",
      mime: "text/xml",
    });
    expect(p2).toMatch(/\.xml$/);
  });

  it("extensão default 'bin' pra mime desconhecido", () => {
    const p = buildStoragePath({
      payoutId: "p1",
      originalName: "misterioso",
      mime: "application/octet-stream",
    });
    expect(p).toMatch(/\.bin$/);
  });
});

describe("constantes de configuração", () => {
  it("BUCKET deve ser billing-documents", () => {
    expect(BUCKET).toBe("billing-documents");
  });

  it("MAX_UPLOAD_BYTES deve ser 5 MB (alinhado ao bucket)", () => {
    expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
  });

  it("ALLOWED_MIMES cobre PDF/XML/imagens", () => {
    expect(ALLOWED_MIMES.has("application/pdf")).toBe(true);
    expect(ALLOWED_MIMES.has("application/xml")).toBe(true);
    expect(ALLOWED_MIMES.has("text/xml")).toBe(true);
    expect(ALLOWED_MIMES.has("image/png")).toBe(true);
    expect(ALLOWED_MIMES.has("image/jpeg")).toBe(true);
    expect(ALLOWED_MIMES.has("image/webp")).toBe(true);
    // negative control
    expect(ALLOWED_MIMES.has("video/mp4")).toBe(false);
    expect(ALLOWED_MIMES.has("application/zip")).toBe(false);
  });
});
