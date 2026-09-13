import { cn } from "@/lib/utils";

/**
 * Renders stored prose as paragraphs. Content is plain text in Phase 1; React
 * escapes it, so nothing from a model or a feed can become markup. Markdown
 * with sanitisation is a later addition and will replace this component.
 */
export function ForumText({ text, className }: { text: string; className?: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return (
    <div className={cn("prose-forum text-[15px] leading-relaxed", className)}>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>
          {paragraph.split("\n").map((line, lineIndex, lines) => (
            <span key={lineIndex}>
              {line}
              {lineIndex < lines.length - 1 && <br />}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
