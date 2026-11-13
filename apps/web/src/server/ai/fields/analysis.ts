import { VISIBLE_RUN_PURPOSES } from "@cubby/schemas/activity-fields";
import { sql } from "drizzle-orm";

import {
  modelAskFor,
  structuredModelInput,
  type ModelInput,
} from "~/server/ai/model-asks";
import {
  LOCATION_DESCRIPTION_FEATURE,
  RUN_SUMMARY_FEATURE,
} from "~/server/ai/policy/features";
/** Photo descriptions and ended-Run summaries are Answers read by fields scopes. */
import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import { entityAttachment, image, run, runStep } from "~/server/db/schema";
import type { ScopeReads } from "~/server/kernel/api";
import { source } from "~/server/kernel/api";
import { rowKey } from "~/server/kernel/keys";

export const analysisSources = [
  source.table(entityAttachment, [
    "entityId",
    "entityKind",
    "imageId",
    "sortOrder",
    "deletedAt",
  ]),
  source.table(image, ["key", "shortcode", "updatedAt", "deletedAt"]),
  source.table(runStep, ["runId", "key", "state", "done", "failed", "skipped"]),
];

export async function loadAnalysis(
  reads: ScopeReads,
  entity: string,
  id: string,
  name: string,
): Promise<ModelInput | null> {
  if (entity === "location") {
    const links = await reads.select(
      entityAttachment,
      [rowKey("Location", id)],
      sql`${entityAttachment.entityKind} = ${entity} AND ${entityAttachment.entityId} = ${id} AND ${entityAttachment.deletedAt} IS NULL`,
    );
    const photos = await reads.rows(
      image,
      links
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .slice(0, 5)
        .map((link) => link.imageId),
    );
    const live = [...photos.values()]
      .filter((photo) => !photo.deletedAt)
      .map((photo) => ({
        id: photo.shortcode,
        url: getR2PublicUrl(photo.key),
        updatedAt: photo.updatedAt,
      }));
    return live.length ? locationDescriptionInput(name, live) : null;
  }
  if (entity === "run") {
    const row = (await reads.rows(run, [id])).get(id);
    if (
      !row?.endedAt ||
      row.deletedAt ||
      row.routine ||
      row.trigger === "ephemeral" ||
      row.endedAt < new Date("2026-11-12T00:00:00.000Z") ||
      !["completed", "failed", "dispatch_failed", "needs_review"].includes(
        row.status,
      ) ||
      !VISIBLE_RUN_PURPOSES.some((purpose) => purpose === row.purpose) ||
      [
        "ai_suggest",
        "background",
        "ai_refresh",
        "connection_discovery",
        "derived_refresh",
      ].includes(row.purpose) ||
      (row.purpose === "mail_discovery" && row.status === "completed")
    )
      return null;
    const steps = await reads.select(
      runStep,
      [rowKey("Run", id)],
      sql`${runStep.runId} = ${id}`,
    );
    return structuredModelInput(
      RUN_SUMMARY_FEATURE,
      RUN_SUMMARY_FEATURE.request({
        purpose: row.purpose,
        status: row.status,
        failureCode: row.failureCode,
        startedAt: row.startedAt?.toISOString(),
        endedAt: row.endedAt.toISOString(),
        steps: steps.map((step) => ({
          key: step.key,
          state: step.state,
          done: step.done,
          failed: step.failed,
          skipped: step.skipped,
        })),
      }),
    );
  }
  return null;
}

export const analysisAsk = (entity: string) =>
  modelAskFor(
    entity === "location" ? LOCATION_DESCRIPTION_FEATURE : RUN_SUMMARY_FEATURE,
  );

export function locationDescriptionInput(
  name: string,
  images: readonly { id: string; url: string; updatedAt: Date }[],
): ModelInput {
  const ordered = [...images].sort((a, b) => a.id.localeCompare(b.id));
  return structuredModelInput(
    LOCATION_DESCRIPTION_FEATURE,
    LOCATION_DESCRIPTION_FEATURE.request(
      ordered.map((photo) => photo.url),
      name,
    ),
    {
      locationName: name,
      images: ordered.map((photo) => ({
        id: photo.id,
        updatedAt: photo.updatedAt.toISOString(),
      })),
    },
  );
}
