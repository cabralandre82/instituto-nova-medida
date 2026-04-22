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
} from "@/lib/patient-treatment";
import { signPatientToken } from "@/lib/patient-tokens";
import {
  formatCurrencyBRL,
  formatDateBR,
  formatTimeBR,
  formatWeekdayLongBR,
} from "@/lib/datetime-br";
import { whatsappSupportUrl } from "@/lib/contact";
import {
  getPatientQuickLinks,
  type LatestPrescription,
  type RescheduleCredit,
  type ShippingAddress,
} from "@/lib/patient-quick-links";
import { ActiveFulfillmentCard } from "./_ActiveFulfillmentCard";
import { PendingOfferCard } from "./_PendingOfferCard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fmtDateTime(iso: string): { date: string; time: string } {
  return {
    date: formatDateBR(iso, {
      weekday: "long",
      day: "2-digit",
      month: "long",
    }),
    time: formatTimeBR(iso),
  };
}

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
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
    quickLinks,
  ] = await Promise.all([
    getUpcomingAppointment(supabase, customerId, now),
    getRenewalInfo(supabase, customerId, now),
    listPastAppointments(supabase, customerId, 3),
    listPendingOffers(supabase, customerId),
    listActiveFulfillments(supabase, customerId),
    getPatientQuickLinks(supabase, customerId),
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
        <p className="mt-2 text-ink-500">{formatWeekdayLongBR(now)}</p>
      </header>

      {quickLinks.rescheduleCredit.kind === "ready" && (
        <section className="mb-8">
          <RescheduleCreditBanner credit={quickLinks.rescheduleCredit} />
        </section>
      )}

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

      <QuickLinksSection
        prescription={quickLinks.latestPrescription}
        shipping={quickLinks.shippingAddress}
      />

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
            hint={`pago em ${formatDateBR(active.paidAt)}`}
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
        <div className="mt-4 rounded-xl bg-white/60 border border-sage-200 p-4 space-y-2">
          <p className="text-sm text-ink-700">
            Aguardando confirmação do pagamento desta consulta. Assim que o
            pagamento cair, a sala libera automaticamente.
          </p>
          <p className="text-sm text-ink-600">
            Está parado há mais de 1 dia ou você pagou e continua aqui?{" "}
            <a
              href={whatsappSupportUrl(
                "Olá! Minha consulta está em 'Aguardando confirmação do pagamento'. Podem verificar?",
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-sage-400 hover:text-ink-800 font-medium"
            >
              Fale com a equipe pelo WhatsApp
            </a>
            .
          </p>
        </div>
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
            : `termina em ${formatDateBR(active.cycleEndsAt)}`}
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

/**
 * Atalhos de auto-atendimento — PR-072 · D-080 · finding 1.7.
 * Só renderiza se pelo menos um atalho tiver conteúdo relevante;
 * em estados totalmente vazios (paciente novo, sem consulta ainda)
 * some pra não poluir.
 */
function QuickLinksSection({
  prescription,
  shipping,
}: {
  prescription: LatestPrescription;
  shipping: ShippingAddress;
}) {
  const hasPrescription = prescription.kind === "ready";
  const hasShippingInfo = shipping.kind !== "missing";
  if (!hasPrescription && !hasShippingInfo) return null;

  return (
    <section className="mb-10 rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
      <div className="flex items-center justify-between mb-4 gap-4">
        <h2 className="font-serif text-[1.25rem] text-ink-800">
          Atalhos
        </h2>
        <Link
          href="/paciente/meus-dados"
          className="text-sm text-sage-700 hover:text-sage-800 whitespace-nowrap"
        >
          Meus dados →
        </Link>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        {prescription.kind === "ready" && (
          <PrescriptionQuickLink data={prescription} />
        )}
        <ShippingQuickLink data={shipping} />
      </div>
    </section>
  );
}

function PrescriptionQuickLink({
  data,
}: {
  data: Extract<LatestPrescription, { kind: "ready" }>;
}) {
  return (
    <div className="rounded-xl border border-sage-200 bg-sage-50 p-5">
      <p className="text-[0.75rem] uppercase tracking-wide text-sage-700 font-medium">
        Receita atual
      </p>
      <p className="mt-1 text-ink-800 font-medium">Prescrição no Memed</p>
      <p className="mt-0.5 text-xs text-ink-500">
        Emitida por {data.doctorName} em {formatDateBR(data.issuedAt)}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <a
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sage-700 hover:text-sage-800 font-medium underline decoration-sage-400"
        >
          Abrir receita no Memed →
        </a>
        <Link
          href={`/paciente/consultas/${data.appointmentId}`}
          className="text-ink-600 hover:text-ink-800"
        >
          Ver consulta
        </Link>
      </div>
    </div>
  );
}

function ShippingQuickLink({ data }: { data: ShippingAddress }) {
  if (data.kind === "ready") {
    return (
      <div className="rounded-xl border border-ink-100 bg-white p-5">
        <p className="text-[0.75rem] uppercase tracking-wide text-ink-500">
          Endereço de entrega
        </p>
        <p className="mt-1 text-ink-800 font-medium">{data.summaryLine}</p>
        {data.complement && (
          <p className="text-xs text-ink-500">{data.complement}</p>
        )}
        <p className="mt-0.5 text-xs text-ink-500">
          {data.cityState} · CEP {data.zipcode}
        </p>
        <div className="mt-3">
          <Link
            href="/paciente/meus-dados/atualizar"
            className="text-sm text-sage-700 hover:text-sage-800 font-medium"
          >
            Revisar endereço →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cream-300 bg-cream-50 p-5">
      <p className="text-[0.75rem] uppercase tracking-wide text-ink-500">
        Endereço de entrega
      </p>
      <p className="mt-1 text-ink-800 font-medium">
        {data.kind === "incomplete"
          ? "Endereço incompleto"
          : "Endereço não cadastrado"}
      </p>
      <p className="mt-0.5 text-xs text-ink-600">
        Cadastre antes da primeira entrega pra evitar atraso ou retorno
        da caixa.
      </p>
      <div className="mt-3">
        <Link
          href="/paciente/meus-dados/atualizar"
          className="text-sm text-sage-700 hover:text-sage-800 font-medium"
        >
          Cadastrar endereço →
        </Link>
      </div>
    </div>
  );
}

/**
 * Banner destacado quando o paciente tem `appointment_credits` ativo —
 * PR-073 · D-081 · finding 2.4. Aparece no topo do dashboard porque:
 *
 *   1. É a primeira coisa que o paciente precisa ver ao entrar (ele já
 *      sabe que a médica não compareceu — queremos reduzir atrito
 *      imediato pro reagendamento).
 *   2. Admin solo marca `consumed` ao agendar; o banner some sozinho.
 *
 * Copy difere por razão. Nunca expõe ids internos ao paciente; a CTA
 * WhatsApp tem mensagem pré-preenchida pra o admin reconhecer de cara.
 */
function RescheduleCreditBanner({
  credit,
}: {
  credit: Extract<RescheduleCredit, { kind: "ready" }>;
}) {
  const isDoctorNoShow = credit.reason === "no_show_doctor";
  const headline = isDoctorNoShow
    ? "Sua próxima consulta é por nossa conta"
    : "A consulta agendada não aconteceu";
  const body = isDoctorNoShow
    ? "A médica não pôde comparecer à sua última consulta. Deixamos um reagendamento gratuito disponível pra você — é só escolher o melhor horário falando com a nossa equipe."
    : "A sala expirou sem atendimento, provavelmente por um problema técnico ou falta de link. Você tem direito a um reagendamento sem custo. Fale com nossa equipe pra escolher um novo horário.";
  const whatsappMessage = isDoctorNoShow
    ? "Olá! Recebi a mensagem de que minha médica não pôde comparecer. Gostaria de reagendar a consulta usando o crédito disponível."
    : "Olá! Minha consulta não aconteceu (sala expirou). Gostaria de reagendar usando o crédito disponível.";
  const urgencyLabel =
    credit.daysRemaining >= 30
      ? null
      : credit.daysRemaining <= 0
        ? "expira hoje"
        : credit.daysRemaining === 1
          ? "expira amanhã"
          : `expira em ${credit.daysRemaining} dias`;

  return (
    <div className="rounded-2xl border border-terracotta-200 bg-terracotta-50 p-5 sm:p-6">
      <p className="text-[0.72rem] uppercase tracking-[0.18em] text-terracotta-700 font-semibold">
        Reagendamento disponível
      </p>
      <h2 className="mt-1 font-serif text-[1.35rem] text-ink-800">
        {headline}
      </h2>
      <p className="mt-2 text-sm text-ink-700 max-w-2xl">{body}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a
          href={whatsappSupportUrl(whatsappMessage)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-full bg-terracotta-600 hover:bg-terracotta-700 text-white text-sm font-medium px-5 py-2.5"
        >
          Reagendar pelo WhatsApp →
        </a>
        {urgencyLabel && (
          <span className="text-xs text-terracotta-700 font-medium">
            · {urgencyLabel}
          </span>
        )}
      </div>
    </div>
  );
}
