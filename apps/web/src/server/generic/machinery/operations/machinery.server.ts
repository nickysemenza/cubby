/**
 * The machinery read and the decisions it offers (ADR 0029 section 10). An
 * entity without a machinery capability reads null, so its clients keep the
 * state badge; a decision is accepted only when the record's current read
 * offers it or when it addresses a field of the record itself.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { ENTITY_NOT_FOUND_REASON } from "@cubby/schemas/identifiers";
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import type { Machinery } from "@cubby/schemas/kernel/machinery";
import { z } from "zod";

import { machineryContract } from "~/contracts/machinery.contract";
import type { Database } from "~/server/db/database";
import { createAppError } from "~/server/errors/app-error";
import { authoredFieldWriter } from "~/server/generic/machinery/repo/field-decisions";
import { buildCrudServices } from "~/server/http/request-context";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

const shortcodeEntity = z.enum(shortcodeEntities);

type DecideInput = z.output<typeof machineryContract.ops.decide.input>;

/** The entity's declared capability, or null when it has none. */
export async function machineryCapabilityOf(
  entity: string,
): Promise<MachineryCapability | null> {
  return (await import("~/server/kernel/api")).machineryCapability(entity);
}

async function recordOf(db: Database, entity: Entity, code: string) {
  const { resolveForRead } = await import("~/server/kernel/api");
  const resolved = await resolveForRead(db, code);
  if (!resolved || resolved.entity !== entity) {
    const shortcode = shortcodeEntity.safeParse(entity);
    throw createAppError(
      shortcode.success
        ? ENTITY_NOT_FOUND_REASON[shortcode.data]
        : "MACHINERY_DECISION_NOT_OFFERED",
      `${entity} not found: ${code}`,
    );
  }
  return resolved;
}

async function readMachinery(
  db: Database,
  viewer: ActorContext,
  input: { entity: Entity; id: string; field?: string },
): Promise<Machinery | null> {
  if (!(await machineryCapabilityOf(input.entity))) return null;
  const record = await recordOf(db, input.entity, input.id);
  const { machinery } = await import("~/server/kernel/api");
  return machinery(
    db,
    viewer,
    { entity: input.entity, id: record.id },
    input.field ? { field: input.field } : undefined,
  );
}

/** A decision the record's read offers, or a field decision on the record. */
function admitted(
  read: Machinery,
  subject: string,
  decision: DecideInput["decisions"][number],
) {
  const target = decision.subject ?? subject;
  if (target === subject && decision.channel !== "identity") return true;
  return read.gaps.items.some((gap) =>
    gap.actions.some(
      (action) =>
        action.channel === decision.channel &&
        action.kind === decision.kind &&
        action.subject === target &&
        action.field === (decision.field ?? null) &&
        JSON.stringify(action.value ?? null) ===
          JSON.stringify(decision.value ?? null),
    ),
  );
}

async function decideForRecord(
  db: Database,
  viewer: ActorContext,
  input: DecideInput,
) {
  if (!(await machineryCapabilityOf(input.entity)))
    throw createAppError(
      "MACHINERY_DECISION_NOT_OFFERED",
      `${input.entity} records have no machinery to decide on`,
    );
  const { decide, machinery, recordSubject } =
    await import("~/server/kernel/api");
  const record = await recordOf(db, input.entity, input.id);
  const subject = recordSubject(input.entity, record.id);
  const read = await machinery(db, viewer, {
    entity: input.entity,
    id: record.id,
  });
  for (const decision of input.decisions)
    if (!admitted(read, subject, decision))
      throw createAppError(
        "MACHINERY_DECISION_NOT_OFFERED",
        `${decision.channel} ${decision.kind} is not offered for ${input.id}`,
      );
  const decisions = await decide(
    db,
    viewer,
    input.decisions.map((decision) => ({
      channel: decision.channel,
      kind: decision.kind,
      subject: decision.subject ?? subject,
      field: decision.field ?? null,
      value: decision.value ?? null,
    })),
    {
      field: authoredFieldWriter({
        ...buildCrudServices(db),
        db,
        actorContext: viewer,
      }),
    },
  );
  return { decisions };
}

async function approveForRecord(
  db: Database,
  viewer: ActorContext,
  input: z.output<typeof machineryContract.ops.approveDrift.input>,
) {
  const { approveDrift, approveDriftClass } =
    await import("~/server/kernel/api");
  const counts = { applied: 0, stale: 0, busy: 0, missing: 0 };
  const read = await readMachinery(db, viewer, input);
  if (!read?.drift || read.drift.proposalHash !== input.proposalHash) {
    counts.missing = 1;
    return counts;
  }
  const scope = read.drift.scope;
  if (input.scope === "class") {
    return approveDriftClass(db, viewer, scope.kind);
  }
  const outcome = await approveDrift(db, viewer, scope, input.proposalHash);
  counts[outcome] += 1;
  return counts;
}

export const machineryHandlers = implementOperationDomain(machineryContract, {
  needsYou: async (context, input) =>
    (await import("~/server/kernel/api")).needsYou(context.db, input),
  runWork: async (context, input) => {
    const record = await recordOf(context.db, "run", input.runId);
    return (await import("~/server/kernel/api")).runWork(context.db, record.id);
  },
  read: async (context, input) => {
    if (!(await machineryCapabilityOf(input.entity)))
      return { machinery: null, absorbed: null };
    const record = await recordOf(context.db, input.entity, input.id);
    return {
      machinery: await readMachinery(context.db, context.actorContext, input),
      absorbed: record.absorbed
        ? { requested: record.absorbed, survivor: record.shortcode }
        : null,
    };
  },
  decide: (context, input) =>
    decideForRecord(context.db, context.actorContext, input),
  approveDrift: (context, input) =>
    approveForRecord(context.db, context.actorContext, input),
});
