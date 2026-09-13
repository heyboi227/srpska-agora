import { fnv1a32 } from "@/lib/random";
import { cn } from "@/lib/utils";

const PALETTE = [
  ["#8b1e2d", "#f3dfe1"],
  ["#1f4d7a", "#dbe7f3"],
  ["#2b6a3f", "#dcefe1"],
  ["#8a5a00", "#f5e9cc"],
  ["#3b3f8f", "#e6e7f7"],
  ["#6b2d7a", "#efe0f3"],
  ["#0f6f6f", "#d8efef"],
  ["#7a3a1f", "#f3e3da"],
] as const;

function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/**
 * Small deterministic avatar: colour and shape derive from the persona's seed,
 * so the same persona always looks the same and no image storage is needed.
 */
export function Avatar({
  seed,
  name,
  size = 32,
  className,
}: {
  seed: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const hash = fnv1a32(seed);
  const [fg, bg] = PALETTE[hash % PALETTE.length] as readonly [string, string];
  const shape = (hash >>> 8) % 3;
  const label = initials(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={`Avatar: ${name}`}
      className={cn("shrink-0 rounded-md", className)}
    >
      <rect width="40" height="40" rx="8" fill={bg} />
      {shape === 0 && <circle cx="32" cy="8" r="9" fill={fg} opacity="0.18" />}
      {shape === 1 && <path d="M0 40 L40 0 L40 40 Z" fill={fg} opacity="0.12" />}
      {shape === 2 && (
        <rect x="24" y="-6" width="24" height="24" rx="6" fill={fg} opacity="0.15" />
      )}
      <text
        x="20"
        y="26"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize={label.length > 1 ? 15 : 18}
        fontWeight="700"
        fill={fg}
      >
        {label}
      </text>
    </svg>
  );
}
