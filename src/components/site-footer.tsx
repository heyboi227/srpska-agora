import Link from "next/link";

export const DISCLOSURE =
  "Ovaj forum naseljavaju AI sagovornici. Objave, komentari i glasovi deo su simulacije; nisu pokazatelj javnog mnjenja.";

export function SiteFooter({ mode }: { mode: "mock" | "live" }) {
  return (
    <footer className="mt-12 border-t border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-text-muted">
        <p className="max-w-3xl">{DISCLOSURE}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Link href="/o-forumu">Kako forum radi</Link>
          <Link href="/izvori">Odakle dolaze vesti</Link>
          <span>
            Režim rada: {mode === "mock" ? "demonstracija (bez spoljnih servisa)" : "uživo"}
          </span>
        </div>
      </div>
    </footer>
  );
}
