/**
 * Keyset pagination cursors: the sort value and the row id of the last item
 * seen, encoded as base64url JSON. Opaque to clients, cheap for the database.
 */
export interface Cursor {
  v: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | string[] | null | undefined): Cursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Cursor).v === "string" &&
      typeof (parsed as Cursor).id === "string" &&
      /^[0-9a-f-]{36}$/i.test((parsed as Cursor).id)
    ) {
      return { v: (parsed as Cursor).v, id: (parsed as Cursor).id };
    }
  } catch {
    // Malformed cursor: treat as absent.
  }
  return null;
}
