/**
 * src/lib/actor-snapshot.test.ts — PR-064 · D-072
 *
 * Testes unitários pra garantir invariantes de normalização:
 *   - trim/lowercase do email
 *   - empty string → null
 *   - kind='system' força userId=null
 *   - system actor snapshot labelled
 */

import { describe, it, expect } from "vitest";
import {
  actorSnapshotFromSession,
  normalizeActorSnapshot,
  systemActorSnapshot,
  type ActorSnapshot,
} from "./actor-snapshot";

describe("normalizeActorSnapshot", () => {
  it("retorna admin sem userId/email quando input vazio", () => {
    const out = normalizeActorSnapshot();
    expect(out).toEqual<ActorSnapshot>({
      userId: null,
      email: null,
      kind: "admin",
    });
  });

  it("trim + lowercase do email", () => {
    const out = normalizeActorSnapshot({
      userId: "u-1",
      email: "  Admin@Example.COM  ",
    });
    expect(out.email).toBe("admin@example.com");
    expect(out.userId).toBe("u-1");
    expect(out.kind).toBe("admin");
  });

  it("empty string em email vira null", () => {
    const out = normalizeActorSnapshot({
      userId: "u-1",
      email: "   ",
    });
    expect(out.email).toBeNull();
  });

  it("empty string em userId vira null", () => {
    const out = normalizeActorSnapshot({
      userId: "   ",
      email: "x@y.com",
    });
    expect(out.userId).toBeNull();
    expect(out.email).toBe("x@y.com");
  });

  it("kind='system' força userId=null mesmo se passado", () => {
    const out = normalizeActorSnapshot({
      userId: "should-be-cleared",
      email: "system:retention",
      kind: "system",
    });
    expect(out.userId).toBeNull();
    expect(out.kind).toBe("system");
    expect(out.email).toBe("system:retention");
  });

  it("kind='patient' preserva userId", () => {
    const out = normalizeActorSnapshot({
      userId: "patient-1",
      email: "patient@example.com",
      kind: "patient",
    });
    expect(out.kind).toBe("patient");
    expect(out.userId).toBe("patient-1");
  });

  it("kind='doctor' preserva userId", () => {
    const out = normalizeActorSnapshot({
      userId: "doctor-1",
      email: "doc@clinica.com",
      kind: "doctor",
    });
    expect(out.kind).toBe("doctor");
  });

  it("null em ambos retorna snapshot vazio", () => {
    const out = normalizeActorSnapshot({ userId: null, email: null });
    expect(out).toEqual({ userId: null, email: null, kind: "admin" });
  });

  it("não lança com entradas não-string (coerção defensiva)", () => {
    const out = normalizeActorSnapshot({
      userId: undefined,
      email: undefined,
    });
    expect(out.userId).toBeNull();
    expect(out.email).toBeNull();
  });
});

describe("actorSnapshotFromSession", () => {
  it("retorna kind='admin' por default", () => {
    const out = actorSnapshotFromSession({ id: "a", email: "a@x.com" });
    expect(out.kind).toBe("admin");
    expect(out.userId).toBe("a");
    expect(out.email).toBe("a@x.com");
  });

  it("aceita kind customizado", () => {
    const out = actorSnapshotFromSession(
      { id: "p", email: "p@x.com" },
      "patient"
    );
    expect(out.kind).toBe("patient");
  });

  it("lida com null/undefined", () => {
    expect(actorSnapshotFromSession(null)).toEqual({
      userId: null,
      email: null,
      kind: "admin",
    });
    expect(actorSnapshotFromSession(undefined, "doctor")).toEqual({
      userId: null,
      email: null,
      kind: "doctor",
    });
  });

  it("lida com campos faltantes", () => {
    const out = actorSnapshotFromSession({ id: "u-1" });
    expect(out.userId).toBe("u-1");
    expect(out.email).toBeNull();
  });
});

describe("systemActorSnapshot", () => {
  it("produz label com prefixo system:", () => {
    const out = systemActorSnapshot("retention");
    expect(out).toEqual({
      userId: null,
      email: "system:retention",
      kind: "system",
    });
  });

  it("não duplica prefixo", () => {
    const out = systemActorSnapshot("system:asaas-webhook");
    expect(out.email).toBe("system:asaas-webhook");
  });

  it("label vazio → email=null", () => {
    const out = systemActorSnapshot("   ");
    expect(out.email).toBeNull();
    expect(out.kind).toBe("system");
  });

  it("lowercase do label", () => {
    const out = systemActorSnapshot("Asaas-Webhook");
    expect(out.email).toBe("system:asaas-webhook");
  });
});
