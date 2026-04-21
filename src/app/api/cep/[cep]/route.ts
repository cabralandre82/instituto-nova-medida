/**
 * GET /api/cep/[cep] — proxy server-side ao ViaCEP (PR-035 · D-053).
 *
 * Substitui o fetch direto do browser para `viacep.com.br`. Motivos:
 *
 *   1. **Trust boundary**: resposta do ViaCEP agora é validada no
 *      servidor (`src/lib/cep.ts`) antes de virar JSON pro cliente.
 *      Prompt injection via Wi-Fi público ou extensão maliciosa fica
 *      bloqueada pela regex de charset + limites de tamanho.
 *   2. **Rate-limit por IP**: 60 lookups / 5min. Evita abuso do proxy
 *      pra estudar CEPs de terceiros via DNS amplification.
 *   3. **Cache de borda curto**: ViaCEP é idempotente por CEP válido.
 *      Colocamos `Cache-Control: public, s-maxage=86400,
 *      stale-while-revalidate=604800` pra reduzir hits ao ViaCEP e
 *      melhorar latência percebida.
 *   4. **Observabilidade**: log de timeout/erro fica no console do
 *      servidor — caso ViaCEP degrade, admin vê pelo Vercel logs.
 *
 * Este endpoint é intencionalmente público (sem auth). Qualquer
 * visitante pode consultar CEP — é UX essencial no formulário de
 * aceite. O rate-limit segura abuso.
 */

import { NextResponse, type NextRequest } from "next/server";
import { fetchViaCep, isSyntaxValidCep, normalizeCep } from "@/lib/cep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ────────────────────────────────────────────────────────────────────────
// Rate-limit in-memory. Mesma ideia do magic-link: não é cross-region
// (cada lambda warm tem seu Map), mas cobre abuso trivial 1 IP → 1 host.
// Vercel cold-start zera o bucket; trade-off aceitável pro perfil.
// ────────────────────────────────────────────────────────────────────────

const MAX_PER_WINDOW = 60;
const WINDOW_MS = 5 * 60 * 1000;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || cur.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (cur.count >= MAX_PER_WINDOW) return false;
  cur.count += 1;
  return true;
}

function getClientIp(req: NextRequest | Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip");
  return forwardedFor || realIp || "unknown";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ cep: string }> }
) {
  const { cep: rawParam } = await params;
  const cep = normalizeCep(rawParam);

  if (!isSyntaxValidCep(cep)) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_cep",
        message: "CEP precisa ter exatamente 8 dígitos.",
      },
      { status: 400 }
    );
  }

  const ip = getClientIp(req);
  if (!rateLimitOk(ip)) {
    return NextResponse.json(
      {
        ok: false,
        code: "rate_limited",
        message: "Muitas consultas de CEP. Aguarde alguns minutos.",
      },
      { status: 429, headers: { "Retry-After": "300" } }
    );
  }

  const result = await fetchViaCep(cep);

  if (!result.ok) {
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "invalid_cep"
        ? 400
        : result.code === "timeout"
        ? 504
        : 502; // network_error, invalid_response → 502 (gateway failure)
    // No erro não setamos cache: permite retry.
    return NextResponse.json(result, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }

  // Sucesso: cache público agressivo. ViaCEP é idempotente por CEP.
  // `s-maxage` é pra Vercel Edge Cache; `stale-while-revalidate` permite
  // servir a versão em cache enquanto revalida em background.
  return NextResponse.json(
    {
      ok: true,
      cep: result.cep,
      street: result.street,
      district: result.district,
      city: result.city,
      state: result.state,
    },
    {
      status: 200,
      headers: {
        "cache-control":
          "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    }
  );
}
