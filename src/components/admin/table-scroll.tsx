import type { ReactNode } from "react";

/** Wide tables scroll inside their own container, never the page. */
export function TableScroll({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      className="max-w-full overflow-x-auto rounded-md border border-border"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

export const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-text-muted";
export const TD = "px-3 py-2 align-top";
export const TR = "border-t border-border";
