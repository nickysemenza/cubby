import { z } from "zod";

/**
 * One action's availability on one record, as `entity.detail` and every
 * `entity.list` row carry it under `actions`. The server evaluates it
 * (`apps/web/src/server/generic/actions/entity-action-states.ts`); clients
 * render it and derive no availability themselves.
 */
export const entityActionState = z.object({
  /** A manifest verb id: a declared verb or a kernel one (edit, delete, merge, bulkEdit). */
  id: z.string(),
  enabled: z.boolean(),
  /** Why the record cannot take the action yet, in member wording; null when enabled. */
  reason: z.string().nullable(),
});
export type EntityActionState = z.infer<typeof entityActionState>;
export const entityActionStates = z.array(entityActionState);

type ActionAvailabilityRule = {
  /**
   * The record must carry a value at this path (`readPath` grammar): null,
   * an empty string and an empty array are missing.
   */
  readonly requires?: { readonly path: string; readonly reason: string };
  /** The verb writes this value, so a record already holding it has nothing to do. */
  readonly unlessValue?: {
    readonly path: string;
    readonly value: string;
    readonly reason: string;
  };
};

const missingLogoWebsite = {
  path: "website",
  reason: "Add a website in Edit to fetch a logo.",
} as const;

/**
 * Per-verb record requirements, keyed by manifest verb id. The one
 * declaration of when a declared verb cannot run on a record; native
 * coverage plans reference it rather than restating it.
 */
export const actionAvailabilityRules = {
  fetchLogo: { requires: missingLogoWebsite },
  refreshLogo: { requires: missingLogoWebsite },
  complete: {
    unlessValue: { path: "status", value: "done", reason: "Already done." },
  },
} as const satisfies Readonly<Record<string, ActionAvailabilityRule>>;

export const actionAvailabilityRuleFor = (
  verb: string,
): ActionAvailabilityRule | undefined =>
  Object.hasOwn(actionAvailabilityRules, verb)
    ? // SAFETY: `Object.hasOwn` just proved `verb` is a declared rule key.
      actionAvailabilityRules[verb as keyof typeof actionAvailabilityRules]
    : undefined;
