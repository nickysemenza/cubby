import { EXTRACT_ORDER_TOOL } from "@cubby/schemas/import-run-agent";
import { mailMessageRef } from "@cubby/schemas/mailbox-research";
import type { ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";

import type { EscalationStore } from "./escalation";

export const isMailExtractionCall = (
  call: Pick<ToolCall, "name" | "arguments">,
) =>
  call.name === EXTRACT_ORDER_TOOL ||
  (call.name === "mcp__cubby__purchase_import" &&
    call.arguments.action === "prepare");

const evidence = mailMessageRef.extend({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MailAttemptEvidence = z.infer<typeof evidence>;
const claim = z
  .object({
    kind: z.literal("email"),
    email: mailMessageRef.extend({
      checksum: evidence.shape.checksum.optional(),
    }),
    read: z.object({ checksum: evidence.shape.checksum }).nullable().optional(),
  })
  .refine((value) => Boolean(value.read?.checksum ?? value.email.checksum));
const attempts = z.object({
  primary: z.array(z.string()),
  escalation: z.array(z.string()),
});
const CURRENT = "mail-attempts:current";
const currentEvidence = z.object({ source: evidence, complete: z.boolean() });
const completeClaim = z.object({
  read: z.object({
    boundToRun: z.literal(true),
    attachments: z.array(z.unknown()).length(0),
    content: z.object({
      truncated: z.literal(false),
      nextOffset: z.null(),
      bodyShortened: z.literal(false),
      headersOmitted: z.literal(false),
      linksOmitted: z.literal(0),
      imagesOmitted: z.literal(0),
      structuredDataOmitted: z.literal(0),
    }),
  }),
});
const LIMITS = { primary: 2, escalation: 1 } as const;

/** Semantic attempts belong to source evidence, not a claim, model turn or tool name. */
export function mailAttempts(store: EscalationStore) {
  function current() {
    const raw = store.read(CURRENT);
    return raw ? currentEvidence.parse(JSON.parse(raw)) : undefined;
  }

  return {
    ordinaryEvidence: () => {
      const value = current();
      return value?.complete ? value.source : undefined;
    },
    observeClaim(result: unknown) {
      const parsed = claim.safeParse(result);
      // A none/stopped/unreadable claim must not reuse the previous original.
      store.write(
        CURRENT,
        parsed.success
          ? JSON.stringify({
              source: {
                ...parsed.data.email,
                checksum:
                  parsed.data.read?.checksum ?? parsed.data.email.checksum,
              },
              complete: completeClaim.safeParse(result).success,
            })
          : "",
      );
    },
    admit(callId: string, stage: keyof typeof LIMITS) {
      const source = current()?.source;
      if (!source) return { kind: "no_evidence" as const };
      const key = `mail-attempts:${JSON.stringify(source)}`;
      const raw = store.read(key);
      const saved: z.infer<typeof attempts> = raw
        ? attempts.parse(JSON.parse(raw))
        : { primary: [], escalation: [] };
      // Recovery can run under a changed model configuration; the original
      // call still consumes exactly the stage it was admitted under.
      if (saved.primary.includes(callId) || saved.escalation.includes(callId))
        return { kind: "admitted" as const, source };
      if (saved[stage].length >= LIMITS[stage])
        return { kind: "exhausted" as const, source };
      saved[stage].push(callId);
      store.write(key, JSON.stringify(saved));
      return { kind: "admitted" as const, source };
    },
  };
}
