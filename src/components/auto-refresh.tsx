"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Refreshes the server-rendered page roughly every 30 seconds while it is
 * visible. Reads only: a refresh never triggers generation. Back-off doubles
 * the interval when the tab is hidden or a refresh fails, up to five minutes.
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const delayRef = useRef(intervalMs);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        if (document.visibilityState !== "visible") {
          delayRef.current = Math.min(delayRef.current * 2, 300_000);
          schedule();
          return;
        }
        try {
          router.refresh();
          delayRef.current = intervalMs;
        } catch {
          delayRef.current = Math.min(delayRef.current * 2, 300_000);
        }
        schedule();
      }, delayRef.current);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        delayRef.current = intervalMs;
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, intervalMs]);

  return null;
}
