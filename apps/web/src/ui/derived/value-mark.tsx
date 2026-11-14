import {
  fieldDecisionOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import {
  FIELD_STALE_LABEL,
  FIELD_WAITING_LABEL,
} from "@cubby/schemas/field-envelope-presentation";
import { cn } from "cn";
import type { ReactNode } from "react";

/** A computed value Cubby has not published: the one missing-value phrase. */
export function WaitingValue() {
  return (
    <span
      title={FIELD_WAITING_LABEL}
      className="min-w-0 truncate font-sans text-muted-foreground"
    >
      {FIELD_WAITING_LABEL}
    </span>
  );
}

/** Marks stay in the value flow, independent of hover-only cell controls. */
export function FieldValueMark({
  envelope,
  children,
}: {
  envelope?: ReadableFieldEnvelope;
  children: ReactNode;
}) {
  const provenance = envelope
    ? fieldDecisionOf(envelope)?.provenance
    : undefined;
  const inherited = provenance?.kind === "inherited";
  const stale =
    envelope?.result.kind === "cached" && envelope.result.freshness === "stale";
  const missing = envelope?.result.kind === "missing";
  return (
    <span
      data-slot="derived-value"
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1",
        inherited && "text-muted-foreground",
      )}
    >
      {inherited ? (
        <>
          <span
            className="w-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          >
            ↳
          </span>
          <span className="sr-only">Inherited, </span>
        </>
      ) : null}
      <span className="min-w-0 truncate">
        {missing ? <WaitingValue /> : children}
      </span>
      {!missing && stale ? (
        <span className="shrink-0 font-sans text-xs text-muted-foreground">
          {FIELD_STALE_LABEL}
        </span>
      ) : null}
    </span>
  );
}
