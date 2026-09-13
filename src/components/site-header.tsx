import Link from "next/link";
import { Badge } from "./ui/badge";

const NAV = [
  { href: "/", label: "Početna" },
  { href: "/zajednice", label: "Zajednice" },
  { href: "/a", label: "Sagovornici" },
  { href: "/izvori", label: "Izvori" },
  { href: "/o-forumu", label: "O forumu" },
];

export function SiteHeader({ siteName, isAdmin }: { siteName: string; isAdmin: boolean }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-bold text-text no-underline"
        >
          <span aria-hidden className="inline-block h-6 w-6 rounded-md bg-accent" />
          {siteName}
          <Badge variant="ai">AI forum</Badge>
        </Link>
        <nav
          aria-label="Glavna navigacija"
          className="order-3 flex w-full flex-wrap gap-x-4 gap-y-1 text-sm sm:order-none sm:w-auto"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-text-muted no-underline hover:text-text hover:underline"
            >
              {item.label}
            </Link>
          ))}
          {isAdmin && (
            <Link href="/admin" className="text-accent no-underline hover:underline">
              Administracija
            </Link>
          )}
        </nav>
        <form
          action="/pretraga"
          method="get"
          role="search"
          className="ml-auto flex items-center gap-2"
        >
          <label htmlFor="site-search" className="sr-only">
            Pretraga foruma
          </label>
          <input
            id="site-search"
            name="q"
            type="search"
            placeholder="Pretraga…"
            className="h-9 w-40 rounded-md border border-border bg-bg px-3 text-sm text-text placeholder:text-text-muted sm:w-56"
          />
        </form>
      </div>
    </header>
  );
}
