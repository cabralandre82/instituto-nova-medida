/**
 * Tokens curtos (HMAC-SHA256) para o link de consulta enviado ao paciente.
 *
 * Não usamos JWT pra evitar dependência de outra lib + ataques de
 * algoritmo. Formato:
 *
 *     <appointment_id>.<exp>.<sig>
 *
 *   - appointment_id : UUID v4 (36 chars)
 *   - exp            : Unix epoch em segundos (string base10)
 *   - sig            : HEX SHA-256 HMAC truncado a 32 chars (16 bytes)
 *                      assinado com PATIENT_TOKEN_SECRET
 *
 * Verificação: comparação em tempo constante; rejeita se vencido.
 *
 * Por que é seguro o suficiente:
 *   - SECRET 256-bit no servidor; sem ele não dá pra forjar.
 *   - exp embutido no payload já coberto pela sig (tamper-evident).
 *   - 16 bytes de truncamento ainda dão 128 bits de força contra forgery.
 *   - Não carrega claims sensíveis — só o appointment_id, que sozinho
 *     não vale nada (a sala Daily ainda exige token Daily efêmero).
 */

import crypto from "node:crypto";

const SEPARATOR = ".";
const SIG_HEX_LENGTH = 32; // 16 bytes

function getSecret(): Buffer {
  const raw = process.env.PATIENT_TOKEN_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "[patient-tokens] PATIENT_TOKEN_SECRET ausente ou curta (>= 32 chars)."
    );
  }
  return Buffer.from(raw, "utf8");
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function compute(appointmentId: string, exp: number): string {
  const h = crypto.createHmac("sha256", getSecret());
  h.update(appointmentId);
  h.update(SEPARATOR);
  h.update(String(exp));
  return h.digest("hex").slice(0, SIG_HEX_LENGTH);
}

export type SignOptions = {
  /** Validade em segundos a partir de agora. Default 7 dias. */
  ttlSeconds?: number;
};

export function signPatientToken(
  appointmentId: string,
  opts: SignOptions = {}
): string {
  if (!isUuid(appointmentId)) {
    throw new Error("[patient-tokens] appointmentId não é UUID");
  }
  const ttl = Math.max(60, Math.min(opts.ttlSeconds ?? 7 * 24 * 3600, 60 * 24 * 3600));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = compute(appointmentId, exp);
  return `${appointmentId}${SEPARATOR}${exp}${SEPARATOR}${sig}`;
}

export type VerifyResult =
  | { ok: true; appointmentId: string; exp: number }
  | { ok: false; reason: "malformed" | "invalid_uuid" | "bad_sig" | "expired" };

export function verifyPatientToken(token: string | null | undefined): VerifyResult {
  if (!token) return { ok: false, reason: "malformed" };
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [appointmentId, expStr, sig] = parts;
  if (!isUuid(appointmentId)) return { ok: false, reason: "invalid_uuid" };

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: "malformed" };

  let expected: string;
  try {
    expected = compute(appointmentId, exp);
  } catch {
    return { ok: false, reason: "bad_sig" };
  }

  if (sig.length !== SIG_HEX_LENGTH) return { ok: false, reason: "bad_sig" };

  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_sig" };
  }

  if (Math.floor(Date.now() / 1000) >= exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, appointmentId, exp };
}

/**
 * Helper: monta a URL pública do paciente.
 * Aceita base URL via env `NEXT_PUBLIC_BASE_URL` (sem barra final) ou
 * cai pro path relativo se não tiver.
 */
export function buildConsultationUrl(appointmentId: string, token: string): string {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const path = `/consulta/${appointmentId}?t=${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}
