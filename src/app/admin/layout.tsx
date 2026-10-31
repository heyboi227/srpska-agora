import Link from "next/link";
import type { ReactNode } from "react";
import { getSession } from "@/server/auth";
import { logoutAction } from "./actions";

export const dynamic = "force-dynamic";

const ADMIN_NAV = [
  { href: "/admin", label: "Pregled" },
  { href: "/admin/karantin", label: "Karantin" },
  { href: "/admin/sadrzaj", label: "Sakriveni sadržaj" },
  { href: "/admin/raspored", label: "Raspored" },
  { href: "/admin/troskovi", label: "Troškovi" },
  { href: "/admin/poslovi", label: "Poslovi" },
  { href: "/admin/konfiguracija", label: "Konfiguracija" },
];

/**
 * Admin shell. The login page is inside this segment, so the layout renders
 * children without navigation when there is no session; every other admin page
 * and action calls requireAdmin() itself.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session || session.account.role !== "admin") {
    return <>{children}</>;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm">
        <span className="font-semibold">Administracija</span>
        <nav aria-label="Administracija" className="flex flex-wrap gap-3">
          {ADMIN_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-text-muted no-underline hover:text-text hover:underline"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <form action={logoutAction} className="ml-auto flex items-center gap-2">
          <span className="text-text-muted">Prijavljen: {session.account.username}</span>
          <button
            type="submit"
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-muted"
          >
            Odjava
          </button>
        </form>
      </div>
      {children}
    </div>
  );
}
