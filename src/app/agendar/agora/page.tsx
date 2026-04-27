/**
 * /agendar/agora — PR-080 · D-092
 *
 * Rota canônica de "atendimento agora". Espelha em estrutura
 * `/agendar` (free booking), mas com trilho on-demand:
 *
 *   - Sem cookie de lead → redireciona pra /?aviso=quiz_primeiro.
 *   - Lead expirado → /?aviso=lead_expirado.
 *   - Já tem request pending desse paciente → renderiza
 *     `OnDemandWaitingClient` (countdown + cancel + polling).
 *   - Sem pending → renderiza `OnDemandForm` (formulário do paciente).
 *
 * Diferente de /agendar:
 *   - Não pede slot — atendimento é AGORA.
 *   - Pede chief_complaint (motivo da consulta — ajuda a médica
 *     a decidir se aceita).
 *   - UI de espera tem countdown explícito.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { getSupabaseAdmin } from "@/lib/supabase";
import { LEAD_COOKIE_NAME } from "@/lib/lead-cookie";
import { logger } from "@/lib/logger";
import { OnDemandForm } from "./OnDemandForm";
import { OnDemandWaitingClient } from "./OnDemandWaitingClient";
import { ON_DEMAND_DEFAULT_TTL_SECONDS } from "@/lib/on-demand";

const log = logger.with({ route: "/agendar/agora" });

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Atendimento agora · Instituto Nova Medida",
  description:
    "Solicite uma consulta imediata com uma das nossas médicas online. Sem cobrança nesta etapa.",
  robots: { index: false, follow: false },
};

const LEAD_MAX_AGE_DAYS = 14;

export default async function AgendarAgoraPage() {
  // 1) Lead cookie obrigatório
  const cookieStore = await cookies();
  const leadId = cookieStore.get(LEAD_COOKIE_NAME)?.value ?? null;
  if (!leadId) {
    redirect("/?aviso=quiz_primeiro");
  }

  const sb = getSupabaseAdmin();
  const leadCutoff = new Date(
    Date.now() - LEAD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: lead, error: leadErr } = await sb
    .from("leads")
    .select("id, name, phone")
    .eq("id", leadId)
    .gte("created_at", leadCutoff)
    .maybeSingle();
  if (leadErr) {
    log.error("lead lookup", { err: leadErr });
  }
  if (!lead) {
    redirect("/?aviso=lead_expirado");
  }

  // 2) Detecta se este lead já tem pending (independente do customer
  //    associado — paciente pode ter passado pela /agendar antes,
  //    criado o customer, e agora tá voltando).
  const { data: customers } = await sb
    .from("customers")
    .select("id")
    .eq("lead_id", leadId);
  const customerIds = ((customers ?? []) as Array<{ id: string }>).map(
    (c) => c.id
  );

  let pendingRequestId: string | null = null;
  let pendingExpiresAt: string | null = null;

  if (customerIds.length > 0) {
    const { data: pending } = await sb
      .from("on_demand_requests")
      .select("id, expires_at")
      .in("customer_id", customerIds)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pending) {
      pendingRequestId = (pending as { id: string }).id;
      pendingExpiresAt = (pending as { expires_at: string }).expires_at;
    }
  }

  return (
    <Shell>
      {pendingRequestId ? (
        <OnDemandWaitingClient
          requestId={pendingRequestId}
          expiresAt={pendingExpiresAt!}
        />
      ) : (
        <OnDemandForm
          leadHints={{
            name: (lead.name as string | null) ?? "",
            phone: (lead.phone as string | null) ?? "",
          }}
          defaultTtlSeconds={ON_DEMAND_DEFAULT_TTL_SECONDS}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-40 bg-cream-100/85 backdrop-blur-md border-b border-ink-100/60">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center justify-between">
          <Logo href="/" />
          <Link
            href="/agendar"
            className="hidden sm:inline-flex items-center gap-2 text-[0.88rem] text-ink-500 hover:text-ink-800 transition-colors"
          >
            Prefiro agendar →
          </Link>
        </div>
      </header>

      <main className="bg-cream-100">
        <section className="mx-auto px-5 sm:px-8 pt-12 pb-20 sm:pt-16 sm:pb-28 max-w-3xl">
          {children}
        </section>
      </main>

      <Footer />
    </>
  );
}
