import type { ReactNode } from "react";

/**
 * Quiet, deterministic frame for public account and authorization work.
 *
 * The outer shell already provides Cubby's global navigation. This only gives
 * the focused interaction a calm paper field and a single structural rule;
 * it intentionally has no hydrated decoration or route-specific imagery.
 */
export function AuthEntryFrame({ children }: { children: ReactNode }) {
  return (
    <section className="auth-background relative flex min-h-[calc(100dvh-10rem)] items-center justify-center overflow-hidden px-2 py-6 sm:px-4 sm:py-8 max-md:[&_[data-slot=button]]:min-h-11 max-md:[&_[data-slot=form-control]]:min-h-11">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-border/70"
      />
      <div className="relative z-10 w-full max-w-md">{children}</div>
    </section>
  );
}
