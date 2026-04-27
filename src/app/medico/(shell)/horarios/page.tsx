/**
 * /medico/horarios — médica edita a própria agenda recorrente
 * (PR-076 · D-088).
 *
 * Server component carrega blocos atuais (ativos + inativos) +
 * estado atual de presença (toggle de plantão online). Hands off
 * pra client component pra interação.
 *
 * Fora de escopo dessa tela:
 *   - Plantões reais (presença online) ficam aqui (toggle).
 *   - Edição de slots individuais (cancelar uma data específica)
 *     fica em `/medico/agenda`.
 */

import { requireDoctor } from "@/lib/auth";
import {
  listAvailabilityForDoctor,
  type AvailabilityRow,
} from "@/lib/doctor-availability";
import { getCurrentPresence } from "@/lib/doctor-presence";
import { HorariosClient } from "./HorariosClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Horários · Médica" };

export default async function HorariosPage() {
  const { doctorId } = await requireDoctor();

  const [blocks, presence] = await Promise.all([
    listAvailabilityForDoctor(doctorId, { includeInactive: true }),
    getCurrentPresence(doctorId),
  ]);

  const initialBlocks: AvailabilityRow[] = blocks;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl sm:text-3xl font-bold text-ink-800">
          Meus horários
        </h1>
        <p className="text-ink-600 text-[0.95rem] max-w-2xl">
          Configure a sua disponibilidade semanal recorrente para consultas
          agendadas e plantões. Pacientes só conseguem agendar dentro desses
          horários.
        </p>
      </header>

      <HorariosClient
        initialBlocks={initialBlocks}
        initialPresenceStatus={presence?.status ?? "offline"}
      />
    </div>
  );
}
