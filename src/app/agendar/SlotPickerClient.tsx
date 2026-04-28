"use client";

import { useRouter } from "next/navigation";
import { SlotsGrid, type GridSlot } from "@/components/SlotsGrid";

export function SlotPickerClient({
  slots,
  showDoctorLabel = false,
}: {
  slots: GridSlot[];
  showDoctorLabel?: boolean;
}) {
  const router = useRouter();
  return (
    <SlotsGrid
      slots={slots}
      showDoctorLabel={showDoctorLabel}
      onPick={(iso, doctorId) => {
        const params = new URLSearchParams({ slot: iso });
        if (doctorId) params.set("doctorId", doctorId);
        router.push(`/agendar?${params.toString()}`);
      }}
      emptyMessage="Sem horários disponíveis nos próximos 7 dias."
    />
  );
}
