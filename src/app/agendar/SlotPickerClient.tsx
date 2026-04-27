"use client";

import { useRouter } from "next/navigation";
import { SlotsGrid, type GridSlot } from "@/components/SlotsGrid";

export function SlotPickerClient({ slots }: { slots: GridSlot[] }) {
  const router = useRouter();
  return (
    <SlotsGrid
      slots={slots}
      onPick={(iso) =>
        router.push(`/agendar?slot=${encodeURIComponent(iso)}`)
      }
      emptyMessage="Sem horários disponíveis nos próximos 7 dias."
    />
  );
}
