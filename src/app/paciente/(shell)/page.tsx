/**
 * /paciente · Dashboard — D-043
 *
 * Resume em 1 tela o que o paciente precisa saber:
 *   - Próxima consulta (com CTA "entrar na sala" quando dentro da
 *     janela, via token HMAC gerado server-side).
 *   - Status do tratamento (ciclo ativo, dias restantes, % progresso)
 *     + CTA de renovação se está expirando.
 *   - Shortcut pra histórico.
 */

import Link from "next/link";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getRenewalInfo,
  getUpcomingAppointment,
  labelForAppointmentStatus,
  listActiveFulfillments,
  listPastAppointments,
  listPendingOffers,
  type PendingOffer,
} from "@/lib/patient-treatment";
import { signPatientToken } from "@/lib/patient-tokens";
import { ActiveFulfillmentCard } from "./_ActiveFulfillmentCard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fmtDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      timeZone: "America/Sao_Paulo",
    }),
    time: d.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Sao_Paulo",
    }),
  };
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export default async function PatientDashboard() {
  const { customerId } = await requirePatient();
  const supabase = getSupabaseAdmin();

  const now = new Date();
  const [
    upcoming,
    renewal,
    history,
    pendingOffers,
    activeFulfillments,
  ] = await Promise.all([
    getUpcomingAppointment(supabase, customerId, now),
    getRenewalInfo(supabase, customerId, now),
    listPastAppointments(supabase, customerId, 3),
    listPendingOffers(supabase, customerId),
    listActiveFulfillments(supabase, customerId),
  ]);

  const active = renewal.active;

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Visão geral
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Seu tratamento
        </h1>
        <p className="mt-2 text-ink-500">
          {now.toLocaleDateString("pt-BR", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
      </header>

      {pendingOffers.length > 0 && (
        <section className="mb-8 space-y-3">
          {pendingOffers.map((offer) => (
            <PendingOfferCard key={offer.fulfillmentId} offer={offer} />
          ))}
        </section>
      )}

      {activeFulfillments.length > 0 && (
        <section className="mb-8 space-y-3">
          <h2 className="font-serif text-[1.25rem] text-ink-800 mb-3">
            Meu tratamento em andamento
          </h2>
          {activeFulfillments.map((f) => (
            <ActiveFulfillmentCard key={f.fulfillmentId} fulfillment={f} />
          ))}
        </section>
      )}

      {renewal.status === "expired" && (
        <div className="mb-6 rounded-2xl border border-terracotta-300 bg-terracotta-50 p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-terracotta-800">
            <strong>Seu ciclo de tratamento acabou.</strong> Renove para
            continuar o acompanhamento e receber novas doses.
          </p>
          <Link
            href="/paciente/renovar"
            className="inline-flex items-center px-3 py-1.5 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-900 whitespace-nowrap"
          >
            Renovar agora →
          </Link>
        </div>
      )}

      {renewal.status === "expiring_soon" && active && (
        <div className="mb-6 rounded-2xl border border-cream-300 bg-cream-100 p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-700">
            <strong>
              Faltam {active.daysRemaining} dia
              {active.daysRemaining === 1 ? "" : "s"}
            </strong>{" "}
            para fim do seu ciclo. Renove com antecedência pra não ficar
            sem medicação.
          </p>
          <Link
            href="/paciente/renovar"
            className="inline-flex items-center px-3 py-1.5 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-900 whitespace-nowrap"
          >
            Ver renovação →
          </Link>
        </div>
      )}

      <section className="grid lg:grid-cols-2 gap-6 mb-10">
        <UpcomingCard upcoming={upcoming} />
        <TreatmentCard
          renewal={renewal}
          hasUpcoming={upcoming !== null}
        />
      </section>

      <section className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
        <div className="flex items-center justify-between mb-4 gap-4">
          <h2 className="font-serif text-[1.25rem] text-ink-800">
            Consultas recentes
          </h2>
          <Link
            href="/paciente/consultas"
            className="text-sm text-sage-700 hover:text-sage-800 whitespace-nowrap"
          >
            Ver todas →
          </Link>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-ink-500">
            Você ainda não teve consultas concluídas. Quando tiver, o
            histórico aparece aqui.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {history.map((h) => {
              const { date, time } = fmtDateTime(h.scheduledAt);
              return (
                <li key={h.id} className="py-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-ink-800 capitalize">
                      {date} · <span className="font-mono text-sm">{time}</span>
                    </div>
                    <div className="text-xs text-ink-500 mt-0.5">
                      {h.doctorName} · {labelForAppointmentStatus(h.status)}
                    </div>
                  </div>
                  <Link
                    href={`/paciente/consultas/${h.id}`}
                    className="text-sm text-sage-700 hover:text-sage-800"
                  >
                    Detalhes →
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {active && (
        <section className="mt-8 grid sm:grid-cols-2 gap-4 text-sm">
          <InfoCell
            label="Plano atual"
            value={active.planName}
            hint={active.planMedication ?? undefined}
          />
          <InfoCell
            label="Investimento do ciclo"
            value={brl(active.paymentAmountCents)}
            hint={`pago em ${new Date(active.paidAt).toLocaleDateString("pt-BR")}`}
          />
        </section>
      )}
    </div>
  );
}

function UpcomingCard({
  upcoming,
}: {
  upcoming: Awaited<ReturnType<typeof getUpcomingAppointment>>;
}) {
  if (!upcoming) {
    return (
      <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-2">Próxima consulta</h2>
        <p className="text-ink-500 text-sm">
          Nenhuma consulta agendada. Quando a médica liberar um horário,
          ele aparece aqui.
        </p>
      </div>
    );
  }

  const { date, time } = fmtDateTime(upcoming.scheduledAt);
  const entryWindowMinutes = 30;
  const minutesUntil = upcoming.minutesUntil;
  const canJoin =
    minutesUntil <= entryWindowMinutes &&
    minutesUntil >= -(upcoming.durationMinutes + entryWindowMinutes);

  const isPendingPayment = upcoming.status === "pending_payment";

  // Hint de tempo
  let whenHint: string;
  if (minutesUntil > 60 * 24) {
    const days = Math.ceil(minutesUntil / (60 * 24));
    whenHint = `em ${days} dia${days === 1 ? "" : "s"}`;
  } else if (minutesUntil > 60) {
    const hours = Math.floor(minutesUntil / 60);
    whenHint = `em ${hours}h`;
  } else if (minutesUntil > 0) {
    whenHint = `em ${minutesUntil} min`;
  } else if (minutesUntil >= -upcoming.durationMinutes) {
    whenHint = "em andamento";
  } else {
    whenHint = "na sua janela de entrada";
  }

  return (
    <div className="rounded-2xl bg-sage-50 border border-sage-200 p-6 sm:p-7">
      <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
        Próxima consulta
      </p>
      <h2 className="font-serif text-[1.4rem] text-ink-800 leading-tight mb-1">
        {upcoming.doctorName}
      </h2>
      <p className="text-ink-600 text-sm capitalize">
        {date} · <span className="font-mono">{time}</span> ·{" "}
        {upcoming.durationMinutes} min
      </p>
      <p className="text-ink-500 text-sm mt-1">{whenHint}</p>

      {isPendingPayment && (
        <p className="mt-4 text-sm text-ink-600">
          Aguardando confirmação do pagamento. Quando confirmar, esta sala libera.
        </p>
      )}

      {!isPendingPayment && (
        <div className="mt-5">
          {canJoin ? (
            <JoinButton appointmentId={upcoming.id} />
          ) : (
            <Link
              href={`/paciente/consultas/${upcoming.id}`}
              className="inline-flex items-center rounded-xl bg-ink-800 hover:bg-ink-900 text-white text-sm font-medium px-5 py-2.5 transition-colors"
            >
              Ver detalhes
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function JoinButton({ appointmentId }: { appointmentId: string }) {
  // Gera token HMAC on-demand — curto, só vale enquanto a janela
  // estiver aberta (a verificação real ocorre em /api/paciente/.../join).
  let token: string | null = null;
  try {
    token = signPatientToken(appointmentId, { ttlSeconds: 60 * 60 * 4 });
  } catch {
    token = null;
  }

  if (!token) {
    return (
      <Link
        href={`/paciente/consultas/${appointmentId}`}
        className="inline-flex items-center rounded-xl bg-ink-800 hover:bg-ink-900 text-white text-sm font-medium px-5 py-2.5 transition-colors"
      >
        Ver detalhes
      </Link>
    );
  }

  return (
    <Link
      href={`/consulta/${appointmentId}?t=${encodeURIComponent(token)}`}
      className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-[0.98rem] font-semibold px-6 py-3 transition-colors shadow-sm"
    >
      Entrar na sala →
    </Link>
  );
}

function TreatmentCard({
  renewal,
  hasUpcoming,
}: {
  renewal: Awaited<ReturnType<typeof getRenewalInfo>>;
  hasUpcoming: boolean;
}) {
  if (renewal.status === "none") {
    return (
      <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-2">
          Tratamento
        </h2>
        <p className="text-ink-500 text-sm mb-4">
          Você ainda não tem um ciclo ativo. Comece pelo plano que faz
          sentido pra você.
        </p>
        <Link
          href="/planos"
          className="inline-flex items-center rounded-xl bg-ink-800 hover:bg-ink-900 text-white text-sm font-medium px-5 py-2.5 transition-colors"
        >
          Ver planos →
        </Link>
      </div>
    );
  }

  const active = renewal.active!;
  const isExpired = renewal.status === "expired";
  const toneClass = isExpired
    ? "border-terracotta-200 bg-terracotta-50"
    : renewal.status === "expiring_soon"
      ? "border-cream-300 bg-cream-100"
      : "border-ink-100 bg-white";

  return (
    <div className={`rounded-2xl border p-6 sm:p-7 ${toneClass}`}>
      <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
        Tratamento atual
      </p>
      <h2 className="font-serif text-[1.4rem] text-ink-800 leading-tight">
        {active.planName}
      </h2>
      {active.planMedication && (
        <p className="text-sm text-ink-500 mt-1">{active.planMedication}</p>
      )}

      <div className="mt-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-500">Dias restantes</span>
          <span className="font-serif text-[1.6rem] text-ink-800">
            {Math.max(0, active.daysRemaining)}
          </span>
        </div>
        <div className="h-2 bg-ink-100 rounded-full overflow-hidden">
          <div
            className={
              isExpired
                ? "h-full bg-terracotta-500"
                : renewal.status === "expiring_soon"
                  ? "h-full bg-cream-500"
                  : "h-full bg-sage-500"
            }
            style={{ width: `${active.progressPct}%` }}
          />
        </div>
        <p className="text-xs text-ink-500">
          Ciclo de {active.cycleDays} dias ·{" "}
          {isExpired
            ? "expirado"
            : `termina em ${new Date(active.cycleEndsAt).toLocaleDateString("pt-BR")}`}
        </p>
      </div>

      {(isExpired || renewal.status === "expiring_soon") && (
        <div className="mt-5">
          <Link
            href="/paciente/renovar"
            className="inline-flex items-center rounded-xl bg-ink-800 hover:bg-ink-900 text-white text-sm font-medium px-5 py-2.5 transition-colors"
          >
            {isExpired ? "Renovar agora →" : "Ver renovação →"}
          </Link>
        </div>
      )}
      {!isExpired && renewal.status !== "expiring_soon" && !hasUpcoming && (
        <p className="mt-4 text-sm text-ink-500">
          Seu tratamento está em dia. Se quiser agendar uma conversa
          antes do fim do ciclo, fale com a equipe.
        </p>
      )}
    </div>
  );
}

function InfoCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white p-5">
      <p className="text-[0.75rem] uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 text-ink-800 font-medium">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

function PendingOfferCard({ offer }: { offer: PendingOffer }) {
  const isAwaitingPayment = offer.status === "pending_payment";
  const tone = isAwaitingPayment
    ? "border-cream-300 bg-cream-100"
    : "border-sage-200 bg-sage-50";
  const eyebrow = isAwaitingPayment
    ? "Pagamento pendente"
    : "Nova indicação médica";
  const ctaLabel = isAwaitingPayment
    ? "Ir para pagamento →"
    : "Revisar e aceitar →";
  const ctaHref =
    isAwaitingPayment && offer.invoiceUrl
      ? offer.invoiceUrl
      : `/paciente/oferta/${offer.appointmentId}`;
  const isExternal = isAwaitingPayment && !!offer.invoiceUrl;

  return (
    <div
      className={`rounded-2xl border p-5 sm:p-6 flex flex-wrap items-start justify-between gap-4 ${tone}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-1.5">
          {eyebrow}
        </p>
        <h3 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
          {offer.planName}
        </h3>
        {offer.planMedication && (
          <p className="mt-0.5 text-sm text-ink-500">{offer.planMedication}</p>
        )}
        <p className="mt-2 text-sm text-ink-600">
          Indicado por {offer.doctorName} · {brl(offer.pricePixCents)} à vista
        </p>
        {isAwaitingPayment ? (
          <p className="mt-1 text-xs text-ink-500">
            Você já aceitou o plano. Finalize o pagamento pra liberar o envio.
          </p>
        ) : (
          <p className="mt-1 text-xs text-ink-500">
            Abra a indicação pra revisar a prescrição, aceitar e prosseguir.
          </p>
        )}
      </div>
      {isExternal ? (
        <a
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm whitespace-nowrap"
        >
          {ctaLabel}
        </a>
      ) : (
        <Link
          href={ctaHref}
          className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm whitespace-nowrap"
        >
          {ctaLabel}
        </Link>
      )}
    </div>
  );
}
