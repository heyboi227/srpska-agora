"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold">Došlo je do greške</h1>
      <p className="mt-2 text-text-muted">
        Stranica trenutno ne može da se prikaže. Sadržaj foruma je sačuvan; pokušajte ponovo za
        trenutak.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs text-text-muted">Oznaka greške: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-md border border-border bg-surface px-4 py-2 text-sm hover:bg-surface-muted"
      >
        Pokušaj ponovo
      </button>
    </div>
  );
}
