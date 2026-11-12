import type { ActorContext } from "@cubby/schemas/context";
import type {
  EntityReportInput,
  EntityReportManyInput,
  EntityReportManyOut,
  EntityReportOut,
} from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";
import { ENTITY_REPORT_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import {
  ReportExecution,
  type ReportDependency,
  type ReportServices,
} from "~/server/generic/entity-report/repo/dependency";
import { foldRepeatedRows } from "~/server/generic/entity-report/repo/fold-repeats";
import { type ReportViewer } from "~/server/generic/entity-report/repo/records";
/** The blocks both clients draw for one detail slot of one record. */
export async function buildEntityReport(
  db: Database,
  input: EntityReportInput,
  viewer: ReportViewer,
  actor: ActorContext,
  services?: ReportServices,
): Promise<EntityReportOut> {
  if (input.scope.kind !== "record") {
    const { buildCollectionReport } = await import("./collection");
    return foldRepeatedRows(await buildCollectionReport(db, input));
  }
  if (input.slot === "task.briefing")
    throw new Error("task.briefing does not support a record scope.");
  const execution = new ReportExecution({
    db,
    id: input.scope.id,
    slots: [input.slot],
    cursor: input.cursor,
    viewer,
    actor,
    services,
  });
  return foldRepeatedRows(await execution.read(await reportFor(input.slot)));
}

/** Slots preserve requested order and duplicates while sharing declared dependencies. */
export async function buildEntityReports(
  db: Database,
  input: EntityReportManyInput,
  viewer: ReportViewer,
  actor: ActorContext,
  services?: ReportServices,
): Promise<EntityReportManyOut> {
  const entity = input.slots[0]?.split(".")[0];
  if (input.slots.some((slot) => slot.split(".")[0] !== entity))
    throw new Error("A batched report must name slots of one entity.");
  const execution = new ReportExecution({
    db,
    id: input.id,
    slots: input.slots,
    viewer,
    actor,
    services,
  });
  // The execution memoizes shared dependencies by promise, so slots read
  // together overlap their queries and still return in request order.
  const reports = await Promise.all(
    input.slots.map(async (slot) => {
      if (slot === "task.briefing")
        throw new Error("task.briefing does not support a record scope.");
      return {
        slot,
        report: foldRepeatedRows(await execution.read(await reportFor(slot))),
      };
    }),
  );
  return { reports };
}

async function reportFor(
  slot: Exclude<EntityReportInput["slot"], "task.briefing">,
): Promise<ReportDependency<EntityReportOut>> {
  const entity = slot.split(".")[0];
  const load = Object.entries(ENTITY_REPORT_BINDINGS).find(
    ([key]) => key === entity,
  )?.[1];
  const builder =
    load && Object.entries(await load()).find(([key]) => key === slot)?.[1];
  if (!builder || !("load" in builder))
    throw new Error(`No report builder for ${slot}`);
  return builder;
}
