"use client";

import { useActionState } from "react";
import { moderateAction, type ModerationState } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";

const initial: ModerationState = {};

/**
 * Hide or restore one contribution with a public Serbian explanation. Rendered
 * only for administrators; the server action checks the session regardless.
 */
export function ModerationControls({
  targetType,
  targetId,
  threadId,
  status,
}: {
  targetType: "thread" | "comment";
  targetId: string;
  threadId: string;
  status: "published" | "hidden" | "quarantined";
}) {
  const [state, formAction, pending] = useActionState(moderateAction, initial);
  const action = status === "hidden" ? "restore" : "hide";
  return (
    <form action={formAction} className="flex w-full flex-wrap items-center gap-2 text-xs">
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="action" value={action} />
      <label className="sr-only" htmlFor={`obrazlozenje-${targetId}`}>
        Obrazloženje moderacije
      </label>
      <input
        id={`obrazlozenje-${targetId}`}
        name="explanation"
        required
        minLength={10}
        placeholder="Obrazloženje na srpskom (javno)"
        className="h-8 min-w-56 flex-1 rounded-md border border-border bg-bg px-2 text-xs text-text"
      />
      <Button
        type="submit"
        size="sm"
        variant={action === "hide" ? "danger" : "secondary"}
        disabled={pending}
      >
        {pending ? "…" : action === "hide" ? "Sakrij" : "Vrati"}
      </Button>
      {state.error && <span className="w-full text-danger">{state.error}</span>}
      {state.ok && <span className="w-full text-ok">Sačuvano.</span>}
    </form>
  );
}
