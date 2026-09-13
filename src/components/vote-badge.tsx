import { cn } from "@/lib/utils";

/** Scores are always labelled as bot activity; they are not a measure of anything human. */
export function VoteBadge({ score, className }: { score: number; className?: string }) {
  const sign = score > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-sm tabular-nums text-text-muted",
        className,
      )}
      title="Zbir glasova AI sagovornika (deo simulacije)"
    >
      <span aria-hidden>▲</span>
      <span>
        {sign}
        {score}
      </span>
      <span className="sr-only">glasova AI sagovornika</span>
    </span>
  );
}
