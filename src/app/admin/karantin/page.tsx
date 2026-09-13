import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db/client";
import { listQuarantinedActions } from "@/lib/queries/admin";
import { formatBelgradeDateTime } from "@/lib/time";
import { requireAdmin } from "@/server/auth";
import { discardDraftAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Karantin", robots: { index: false } };

interface DraftPayload {
  title?: string | null;
  body?: string;
  reason?: string;
}

interface StoredValidator {
  verdict?: string;
  explanation?: string;
  reasons?: string[];
}

export default async function QuarantinePage() {
  await requireAdmin();
  const actions = await listQuarantinedActions(getDb());

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Karantin</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Nacrti koji nisu prošli proveru pre objave. Ovde se mogu pregledati i odbaciti; ne
          mogu se objaviti zaobilaženjem provere. Ako je provera pogrešila, ispravlja se
          provera, pa sagovornik ponovo pokušava.
        </p>
      </header>

      {actions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-text-muted">
          Karantin je prazan.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {actions.map((action) => {
            const payload = action.payload as DraftPayload;
            const validator =
              (action.gateReport as { validator?: StoredValidator } | null)?.validator ?? null;
            const language = (
              action.gateReport as {
                language?: { outcome?: string; confidence?: number };
              } | null
            )?.language;
            return (
              <li
                key={action.id}
                className="rounded-lg border border-border bg-surface p-4 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <Badge variant="warn">{action.actionType}</Badge>
                  {action.personaSlug && (
                    <Link href={`/a/${action.personaSlug}`}>{action.personaName}</Link>
                  )}
                  {action.communitySlug && <span>· /c/{action.communitySlug}</span>}
                  <span>· {formatBelgradeDateTime(action.createdAt)}</span>
                  <span>· pokušaj {action.attempt}</span>
                  <span className="font-mono">· {action.actionKey}</span>
                </div>
                {payload.title && <p className="mt-2 font-semibold">{payload.title}</p>}
                {payload.body && (
                  <p className="mt-1 whitespace-pre-line text-text">{payload.body}</p>
                )}
                {payload.reason && (
                  <p className="mt-1 text-text-muted">Razlog izmene: {payload.reason}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-1">
                  {action.decisionCodes.map((code) => (
                    <Badge key={code} variant="danger">
                      {code}
                    </Badge>
                  ))}
                </div>
                {language?.outcome && (
                  <p className="mt-2 text-xs text-text-muted">
                    Jezička procena: {language.outcome} (pouzdanost{" "}
                    {Math.round((language.confidence ?? 0) * 100)}%)
                  </p>
                )}
                {validator && (
                  <p className="mt-1 text-xs text-text-muted">
                    Validator: {validator.verdict}
                    {validator.explanation ? ` · ${validator.explanation}` : ""}
                  </p>
                )}
                <form
                  action={discardDraftAction}
                  className="mt-3 flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="actionId" value={action.id} />
                  <label htmlFor={`note-${action.id}`} className="sr-only">
                    Beleška
                  </label>
                  <input
                    id={`note-${action.id}`}
                    name="note"
                    placeholder="Beleška (interna, opciono)"
                    className="h-8 min-w-64 flex-1 rounded-md border border-border bg-bg px-2 text-xs"
                  />
                  <Button type="submit" size="sm" variant="danger">
                    Odbaci nacrt
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
