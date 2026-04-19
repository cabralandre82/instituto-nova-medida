import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <a
      href="#top"
      className={cn("inline-flex items-center gap-2.5 group", className)}
      aria-label="Instituto Nova Medida"
    >
      <svg
        width="30"
        height="30"
        viewBox="0 0 30 30"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle
          cx="15"
          cy="15"
          r="13.25"
          stroke="currentColor"
          strokeWidth="1.4"
          className="text-sage-600 transition-colors group-hover:text-sage-700"
        />
        <path
          d="M9 19V11L15 17V11M21 11V19"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sage-700"
        />
        <circle cx="21" cy="9" r="1.4" className="fill-terracotta-500" />
      </svg>
      <span className="leading-none tracking-tight">
        <span className="block font-serif text-[1.05rem] text-ink-800">
          Instituto
        </span>
        <span className="block font-serif text-[1.05rem] text-ink-800 -mt-0.5">
          Nova Medida
        </span>
      </span>
    </a>
  );
}
