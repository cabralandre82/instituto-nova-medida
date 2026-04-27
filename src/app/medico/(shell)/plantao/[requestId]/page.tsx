/**
 * /medico/plantao/[requestId] — PR-080 · D-092
 *
 * Página de aceite direto, alvo do link WhatsApp `medica_on_demand_request`
 * (PR-079). A médica recebe a notificação no celular, clica e cai aqui
 * já autenticada.
 *
 * Fluxo:
 *   - Server resolve o request + valida estado (pending vs terminal).
 *   - Se já não-pending → mostra estado terminal apropriado, sem botão.
 *   - Se pending → renderiza `_AcceptClient` que faz POST ao aceitar.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getRequestById,
  computeSecondsUntilExpiry,
} from "@/lib/on-demand";
import { firstName } from "@/lib/wa-templates";
import { AcceptClient } from "./_AcceptClient";

export const metadata: Metadata = {
  title: "Aceitar atendimento · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function OnDemandAcceptPage(props: {
  params: Promise<{ requestId: string }>;
}) {
  await requireDoctor();
  const { requestId } = await props.params;

  const request = await getRequestById(requestId);

  if (!request) {
    return (
      <Layout>
        <Banner kind="warn" title="Solicitação não encontrada">
          Esse link pode ter sido digitado errado ou pertence a outra
          plataforma. Volte para o painel.
        </Banner>
        <BackLink />
      </Layout>
    );
  }

  if (request.status === "accepted") {
    return (
      <Layout>
        <Banner kind="muted" title="Outra médica já aceitou">
          Esse paciente já está em atendimento.
        </Banner>
        <BackLink />
      </Layout>
    );
  }
  if (request.status === "cancelled") {
    return (
      <Layout>
        <Banner kind="muted" title="Paciente cancelou">
          O paciente desistiu da solicitação.
        </Banner>
        <BackLink />
      </Layout>
    );
  }
  if (request.status === "expired") {
    return (
      <Layout>
        <Banner kind="warn" title="Solicitação expirou">
          O paciente esperou o tempo limite sem ninguém aceitar.
        </Banner>
        <BackLink />
      </Layout>
    );
  }

  // pending — hidrata customer firstName.
  const supabase = getSupabaseAdmin();
  const { data: customer } = await supabase
    .from("customers")
    .select("name")
    .eq("id", request.customer_id)
    .maybeSingle();
  const pacienteFirstName = firstName(
    (customer as { name?: string } | null)?.name ?? "Paciente"
  );

  const secondsUntilExpiry = computeSecondsUntilExpiry({
    expiresAt: request.expires_at,
  });
  if (secondsUntilExpiry <= 0) {
    return (
      <Layout>
        <Banner kind="warn" title="Solicitação expirou">
          O tempo de espera deste paciente acabou.
        </Banner>
        <BackLink />
      </Layout>
    );
  }

  return (
    <Layout>
      <header className="mb-5">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-terracotta-700 font-medium mb-2">
          Atendimento agora
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          {pacienteFirstName} pediu uma consulta agora.
        </h1>
      </header>

      <section className="rounded-2xl border border-ink-100 bg-white p-5 sm:p-6 space-y-4">
        <div>
          <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium">
            O que o paciente está sentindo
          </p>
          <p className="mt-1.5 text-ink-800 leading-relaxed whitespace-pre-line">
            {request.chief_complaint}
          </p>
        </div>

        <AcceptClient
          requestId={request.id}
          initialSecondsUntilExpiry={secondsUntilExpiry}
        />
      </section>

      <BackLink />
    </Layout>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl">{children}</div>;
}

function BackLink() {
  return (
    <p className="mt-6 text-sm">
      <Link
        href="/medico/plantao"
        className="text-ink-500 hover:text-ink-800"
      >
        ← Voltar para o painel de plantão
      </Link>
    </p>
  );
}

function Banner({
  kind,
  title,
  children,
}: {
  kind: "warn" | "muted";
  title: string;
  children: React.ReactNode;
}) {
  const cls =
    kind === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-ink-200 bg-cream-50 text-ink-700";
  return (
    <div className={`rounded-2xl border ${cls} p-5`}>
      <p className="font-serif text-[1.15rem]">{title}</p>
      <p className="mt-1 text-sm leading-relaxed">{children}</p>
    </div>
  );
}
