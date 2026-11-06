import { project } from "~/server/db/retained-tables";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadProjectQualityRecords = qualityCheck.records("project", project, {
  kind: project.kind,
  status: project.status,
  startDate: project.startDate,
  endDate: project.endDate,
});

/** Bump when the rules or their declared scoring metadata change. */
const PROJECT_QUALITY_RULES_VERSION = 1;

type ProjectQualityRecord = Awaited<
  ReturnType<typeof loadProjectQualityRecords>
>[number];
type ProjectDate = Date | string | null;

const dateValue = (value: Exclude<ProjectDate, null>) =>
  value instanceof Date ? value.getTime() : Date.parse(value);

export const projectChecks = defineStoredEntityChecks({
  entity: "project",
  table: project,
  rulesVersion: PROJECT_QUALITY_RULES_VERSION,
  load: loadProjectQualityRecords,
  checks: {
    project_display_image: qualityCheck.hasImage,
    project_kind: qualityCheck.observed<ProjectQualityRecord>(
      (record) => record.kind !== null,
    ),
    // Planning and not-started projects have no actual start to record.
    project_start_date: qualityCheck.when(
      (record: ProjectQualityRecord) =>
        record.status === "in_progress" || record.status === "done",
      qualityCheck.observed<ProjectQualityRecord>(
        (record) => record.startDate !== null,
      ),
    ),
    project_date_order: qualityCheck.when(
      (record: ProjectQualityRecord) =>
        record.startDate !== null && record.endDate !== null,
      qualityCheck.observed<ProjectQualityRecord>(
        (record) => dateValue(record.endDate!) >= dateValue(record.startDate!),
      ),
    ),
  },
});
