import { normalizeForSearch } from "@/lib/serbian/normalize";

/** Derived search field stored next to the original text. */
export function searchTextFor(...parts: (string | null | undefined)[]): string {
  return normalizeForSearch(
    parts.filter((part): part is string => Boolean(part)).join(" "),
  ).slice(0, 20_000);
}

/** Whitespace-collapsed excerpt with an ellipsis when truncated. */
export function excerpt(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
