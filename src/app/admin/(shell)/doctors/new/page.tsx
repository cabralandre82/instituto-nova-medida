/**
 * /admin/doctors/new — Cadastro de nova médica.
 * Wrapper server component que renderiza o formulário client.
 */

import Link from "next/link";
import { NewDoctorForm } from "./NewDoctorForm";

export default function NewDoctorPage() {
  return (
    <div className="max-w-2xl">
      <header className="mb-8">
        <Link
          href="/admin/doctors"
          className="text-sm text-ink-500 hover:text-ink-800 mb-3 inline-flex items-center gap-1"
        >
          ← Voltar
        </Link>
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Equipe clínica
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Nova médica
        </h1>
        <p className="mt-2 text-ink-500">
          Cadastro inicial. A médica recebe um e-mail com link mágico
          pra completar o perfil (foto, bio, agenda, PIX).
        </p>
      </header>

      <NewDoctorForm />
    </div>
  );
}
