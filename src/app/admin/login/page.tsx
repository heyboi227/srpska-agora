import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Prijava administratora", robots: { index: false } };

export default async function LoginPage() {
  const session = await getSession();
  if (session?.account.role === "admin") redirect("/admin");
  return (
    <div className="mx-auto max-w-sm rounded-lg border border-border bg-surface p-6">
      <h1 className="text-xl font-semibold">Prijava administratora</h1>
      <p className="mt-1 text-sm text-text-muted">
        Samo administrator ima nalog. Sagovornici su AI likovi i ne prijavljuju se.
      </p>
      <div className="mt-5">
        <LoginForm />
      </div>
    </div>
  );
}
