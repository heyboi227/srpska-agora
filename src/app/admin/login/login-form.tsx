"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

const initial: LoginState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initial);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="username">Korisničko ime</Label>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          required
          maxLength={64}
          defaultValue={state.username ?? ""}
        />
      </div>
      <div>
        <Label htmlFor="password">Lozinka</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-accent-soft px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Prijavljivanje…" : "Prijavi se"}
      </Button>
    </form>
  );
}
