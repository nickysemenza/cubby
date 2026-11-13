import { HIGH_CONFIDENCE_PROBABILITY } from "@cubby/schemas/ai-evaluation";
import { shortcodeEntities } from "@cubby/schemas/entity-roster";
import type { FieldOrigin } from "@cubby/schemas/field-authority";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  FIELD_RESET_LABEL,
  FIELD_VETO_LABEL,
} from "@cubby/schemas/field-envelope-presentation";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { useMachinery } from "~/entity/machinery/record-machinery";
import { machinery as machineryApi } from "~/integrations/tanstack-query/generated/domains/machinery.gen";
import { suggestion } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";
import { authClient } from "~/lib/auth-client";
import { formatInstant } from "~/lib/date-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";

const suggestable = z.enum(shortcodeEntities);
const percent = (confidence: number) => `${Math.round(confidence * 100)}%`;
const day = (at: string) => formatInstant(at, "monthDay");

type Action = "keep" | "clear" | "release";
const RESULT = {
  keep: "Kept.",
  clear: "Cleared. Cubby will try again.",
  release:
    "Cubby decides this now. Your value stays until it finds a better one.",
} satisfies Record<Action, string>;

export function writerName(
  writer: NonNullable<FieldOrigin["writer"]>,
  viewer: string | undefined,
) {
  if (writer.kind === "cubby") return "Cubby";
  if (writer.kind === "import") return "an import";
  if (writer.kind === "member")
    return writer.name && writer.name !== viewer ? writer.name : "you";
  return writer.name ?? "an agent";
}

/** "Set by Cubby · Nov 3 · 91% sure", or null when nothing is saved. */
function originText(origin: FieldOrigin, viewer: string | undefined) {
  if (origin.released)
    return origin.at
      ? `You let Cubby decide · ${day(origin.at)}`
      : "You let Cubby decide";
  if (!origin.writer) return "Set here";
  const parts = [`Set by ${writerName(origin.writer, viewer)}`];
  if (origin.at) parts.push(day(origin.at));
  if (origin.keptAt) parts.push(`kept by you ${day(origin.keptAt)}`);
  else if (origin.writer.kind === "cubby" && origin.confidence !== null)
    parts.push(`${percent(origin.confidence)} sure`);
  return parts.join(" · ");
}

/**
 * Who set a suggested field's value and the actions that hand it over:
 * Keep or "Wrong, clear it" on Cubby's value, Let Cubby decide on a person's.
 * For an entity with machinery, "Wrong, clear it" records a veto and Let
 * Cubby decide a release; otherwise they go through field authority.
 */
export function FieldOriginLine({
  data,
  origin,
  guess,
  resetOffered = false,
}: {
  data: FieldExplanationOutput;
  origin: FieldOrigin;
  /** The guess value, rendered by the caller as the field displays it. */
  guess: ReactNode;
  /** The chain already offers Let Cubby decide as the field's reset. */
  resetOffered?: boolean;
}) {
  const session = authClient.useSession();
  const [done, setDone] = useState<Action | null>(null);
  const authority = useMutation(
    suggestion.fieldAuthority.mutationOptions({
      onSuccess: (_, input) => setDone(input.action),
    }),
  );
  const decide = useMutation(machineryApi.decide.mutationOptions());
  const kernel = useMachinery({
    entity: data.subject.entityKind,
    id: data.subject.entityId,
  });
  const entity = suggestable.safeParse(data.subject.entityKind).data;
  const assignment = data.envelope.current.assignment;
  const saved = assignment?.kind === "value";
  // An inherited or default value is explained by the chain, not as unset.
  const empty = !saved && fieldValueOf(data.envelope) === null;
  const run = (action: Action) => {
    if (!entity) return;
    setDone(null);
    if (kernel.data?.machinery && action !== "keep") {
      decide.mutate(
        {
          entity: data.subject.entityKind,
          id: data.subject.entityId,
          decisions: [
            action === "clear"
              ? {
                  channel: "veto",
                  kind: "veto",
                  field: data.field,
                  value: z.json().parse(saved ? assignment.value : null),
                }
              : { channel: "assignment", kind: "release", field: data.field },
          ],
        },
        { onSuccess: () => setDone(action) },
      );
      return;
    }
    authority.mutate({
      entity,
      id: data.subject.entityId,
      field: data.field,
      action,
    });
  };
  const canAct = entity !== undefined && done === null;
  return (
    <div className="grid gap-1 text-xs">
      {saved ? (
        <p className="text-muted-foreground">
          {originText(origin, session.data?.user.name)}
        </p>
      ) : !empty ? null : origin.guess ? (
        <p className="text-muted-foreground">
          Not set. Cubby's guess is{" "}
          <span className="text-foreground">{guess}</span>,{" "}
          {percent(origin.guess.confidence)} sure.
          {origin.apply === "auto"
            ? ` It saves on its own at ${percent(HIGH_CONFIDENCE_PROBABILITY)}.`
            : null}
        </p>
      ) : (
        <p className="text-muted-foreground">Not set.</p>
      )}
      {saved && canAct && origin.holder === "cubby" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="link"
            size="xs"
            disabled={authority.isPending || decide.isPending}
            onClick={() => run("keep")}
          >
            Keep
          </Button>
          {/* A handed-back value is the member's: Keep takes it back, there is nothing to clear. */}
          {origin.released ? null : (
            <Button
              variant="link"
              size="xs"
              disabled={authority.isPending || decide.isPending}
              onClick={() => run("clear")}
            >
              {FIELD_VETO_LABEL}
            </Button>
          )}
        </div>
      ) : null}
      {saved &&
      canAct &&
      origin.holder === "person" &&
      origin.apply === "auto" &&
      !origin.fillOnly &&
      !resetOffered ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="link"
            size="xs"
            disabled={authority.isPending || decide.isPending}
            onClick={() => run("release")}
          >
            {FIELD_RESET_LABEL}
          </Button>
        </div>
      ) : null}
      {/* Rendered before it changes so assistive tech announces the result. */}
      <output className="text-muted-foreground">
        {done ? RESULT[done] : null}
      </output>
      {authority.error || decide.error ? (
        <ErrorDisplay
          error={authority.error ?? decide.error}
          title="this change"
        />
      ) : null}
    </div>
  );
}
