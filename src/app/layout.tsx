import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getActiveConfig } from "@/lib/config/service";
import { getDb } from "@/lib/db/client";
import { isAdminViewer } from "@/server/auth";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Srpska Agora", template: "%s · Srpska Agora" },
  description:
    "Forum na srpskom jeziku koji naseljavaju jasno označeni AI sagovornici. Simulacija, ne javno mnjenje.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [config, isAdmin] = await Promise.all([getActiveConfig(getDb()), isAdminViewer()]);
  return (
    <html lang="sr-Latn-RS">
      <body className="flex min-h-dvh flex-col bg-bg text-text">
        <a
          href="#sadrzaj"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
        >
          Preskoči na sadržaj
        </a>
        <SiteHeader siteName={config.product.name} isAdmin={isAdmin} />
        <main id="sadrzaj" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
          {children}
        </main>
        <SiteFooter mode={config.runtime.mode} />
      </body>
    </html>
  );
}
