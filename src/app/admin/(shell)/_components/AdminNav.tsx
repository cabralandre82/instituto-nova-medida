"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

const NAV = [
  { href: "/admin", label: "Visão geral", exact: true },
  { href: "/admin/pacientes", label: "Pacientes" },
  { href: "/admin/fulfillments", label: "Fulfillments" },
  { href: "/admin/doctors", label: "Médicas" },
  { href: "/admin/reliability", label: "Confiabilidade" },
  { href: "/admin/payouts", label: "Repasses" },
  { href: "/admin/refunds", label: "Estornos" },
  { href: "/admin/lgpd-requests", label: "LGPD" },
  { href: "/admin/notifications", label: "Notificações" },
  { href: "/admin/financeiro", label: "Financeiro" },
  { href: "/admin/health", label: "Saúde" },
  { href: "/admin/errors", label: "Erros" },
];

export function AdminNav() {
  const pathname = usePathname() ?? "";

  return (
    <nav className="flex lg:flex-col gap-1 overflow-x-auto -mx-5 px-5 sm:mx-0 sm:px-0">
      {NAV.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "whitespace-nowrap px-4 py-2.5 rounded-lg text-[0.95rem] font-medium transition-colors",
              active
                ? "bg-ink-800 text-white"
                : "text-ink-600 hover:bg-cream-100 hover:text-ink-800"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
