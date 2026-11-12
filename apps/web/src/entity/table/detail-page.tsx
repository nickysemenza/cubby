import type { Entity } from "@cubby/schemas/entity";
import { DEFAULT_DETAIL_GROUPS } from "@cubby/schemas/entity-definitions/definition";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { type FC, type ReactNode, useMemo } from "react";
import { z } from "zod";

import { usePageDetailContext } from "~/entity/page/page";
import { useDebug } from "~/ui/hooks/use-debug";
import { Section } from "~/ui/layout";

import {
  DetailWorkspace,
  type DetailWorkspaceGroup,
} from "../../ui/data-table/detail-workspace";
import type { IndexedSection } from "../../ui/data-table/indexed-sections";
import JsonRenderer from "../../ui/text/json-renderer";
import { AuditLogList } from "../audit-log/audit-log-list";
import {
  EntityRelations,
  supportsEntityGraph,
} from "../relationships/entity-relations";
import { relationshipsSectionIcon } from "../relationships/relationship-tree";

/** Stable id every auto-appended Activity section uses — also the opt-out key: a
 * caller that already supplies a section with this id (e.g. a page composing its
 * own custom activity placement) keeps its own instead of getting a second one. */
const ACTIVITY_SECTION_ID = "history";
const RELATIONS_SECTION_ID = "relationships";

const detailRecordSchema = z
  .object({
    id: z.string().optional(),
    fdc_id: z.number().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();
type DetailRecord = z.output<typeof detailRecordSchema>;

function detailSourceId(
  entity: Entity,
  record: DetailRecord | undefined,
): string | undefined {
  if (!record) return undefined;
  if (record.id) return record.id;
  return entity === "usda-food" && record.fdc_id != null
    ? String(record.fdc_id)
    : undefined;
}

type DetailPlacement = "primary" | "full";

export interface DetailSection extends IndexedSection {
  /** Explicit narrative role; there is deliberately no automatic default. */
  placement: DetailPlacement;
  /**
   * The tab this section sits in. An undeclared supporting group
   * (relations, activity, evidence) is the last tab; any other unknown id, or
   * none, is the first.
   */
  group?: string;
  /** Specialized workflows can supply their own internal surface while retaining
   * the shared relationship, activity, and debug extensions. */
  surface?: "card" | "plain";
}

type DetailGroup = { readonly id: string; readonly title: string };

interface DetailSectionsProps {
  sections: DetailSection[];
  rawData: unknown;
  /** The record's tabs, in order; `DEFAULT_DETAIL_GROUPS` when omitted. */
  groups?: readonly DetailGroup[];
  /** The side column beside the tabs. */
  side?: ReactNode;
}

/**
 * Each section in its tab; tabs with no sections leave. A section naming a
 * group the entity did not declare joins the last tab when it is supporting
 * (relations, activity, evidence), otherwise the first.
 */
function groupSections(
  declared: readonly DetailGroup[],
  sections: readonly DetailSection[],
): DetailWorkspaceGroup[] {
  const supporting = new Set(["relations", "activity", "evidence"]);
  const resolve = (id: string | undefined) =>
    declared.some((tab) => tab.id === id)
      ? id
      : (id !== undefined && supporting.has(id) ? declared.at(-1) : declared[0])
          ?.id;
  const placed = sections.map((section) => ({
    section,
    group: resolve(section.group),
  }));
  return declared.flatMap((tab) => {
    const members = placed
      .filter((entry) => entry.group === tab.id)
      .map((entry) => entry.section);
    return members.length > 0
      ? [{ id: tab.id, title: tab.title, sections: members }]
      : [];
  });
}

function resolveRelationshipDetail(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  sourceId: string | undefined,
  sections: DetailSection[],
) {
  const ownSection = sections.find(
    (section) => section.id === RELATIONS_SECTION_ID,
  );
  const hasSourceViews = pageDetail && supportsEntityGraph(pageDetail.entity);
  if (ownSection || !pageDetail || !sourceId || !hasSourceViews) {
    return { ownSection, section: ownSection };
  }
  const genericSection: DetailSection = {
    id: RELATIONS_SECTION_ID,
    title: "Relationships",
    icon: relationshipsSectionIcon,
    placement: "full",
    group: "relations",
    content: (
      <EntityRelations
        entity={pageDetail.entity}
        sourceId={sourceId}
        placement="detail"
      />
    ),
  };
  return {
    ownSection,
    section: ownSection ?? genericSection,
  };
}

function resolveActivityDetail(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  sourceId: string | undefined,
  sections: DetailSection[],
) {
  const ownSection = sections.find(
    (section) => section.id === ACTIVITY_SECTION_ID,
  );
  if (
    ownSection ||
    !pageDetail ||
    !sourceId ||
    !isAuditableEntity(pageDetail.entity)
  ) {
    return { ownSection, section: ownSection };
  }
  const section: DetailSection = {
    id: ACTIVITY_SECTION_ID,
    title: "History",
    icon: ClockIcon,
    placement: "primary",
    group: "activity",
    content: (
      <AuditLogList
        entityKind={pageDetail.entity}
        entityId={sourceId}
        showEntityLink={false}
      />
    ),
  };
  return { ownSection, section };
}

function validateDetailSectionIds(
  visibleSections: DetailSection[],
  relationship: ReturnType<typeof resolveRelationshipDetail>,
  activity: ReturnType<typeof resolveActivityDetail>,
) {
  const allSections = [...visibleSections];
  if (!relationship.ownSection && relationship.section) {
    allSections.push(relationship.section);
  }
  if (!activity.ownSection && activity.section) {
    allSections.push(activity.section);
  }
  const ids = allSections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Detail section ids must be unique within a record page");
  }
}

function contextSourceId(
  pageDetail: ReturnType<typeof usePageDetailContext>,
  record: DetailRecord | undefined,
) {
  return pageDetail ? detailSourceId(pageDetail.entity, record) : undefined;
}

/**
 * A record's body: its sections in tabs beside the side column, plus the
 * generic Relationships explorer and History when the page brings neither.
 */
export const DetailSections: FC<DetailSectionsProps> = ({
  sections,
  rawData,
  groups = DEFAULT_DETAIL_GROUPS,
  side,
}) => {
  const { isDebugEnabled } = useDebug();
  const pageDetail = usePageDetailContext();
  const parsedDetailRecord = pageDetail
    ? detailRecordSchema.safeParse(rawData)
    : undefined;
  const detailRecord = parsedDetailRecord?.success
    ? parsedDetailRecord.data
    : undefined;
  const sourceId = contextSourceId(pageDetail, detailRecord);
  const relationship = useMemo(
    () => resolveRelationshipDetail(pageDetail, sourceId, sections),
    [pageDetail, sourceId, sections],
  );
  const activity = useMemo(
    () => resolveActivityDetail(pageDetail, sourceId, sections),
    [pageDetail, sourceId, sections],
  );
  validateDetailSectionIds(sections, relationship, activity);
  const tabs = groupSections(groups, [
    ...sections,
    ...(relationship.ownSection || !relationship.section
      ? []
      : [relationship.section]),
    ...(activity.ownSection || !activity.section ? [] : [activity.section]),
  ]);
  return (
    <DetailWorkspace
      groups={tabs}
      side={side}
      footer={
        isDebugEnabled && (
          <Section headingAs="h2" title="Raw details">
            <JsonRenderer input={rawData} pretty />
          </Section>
        )
      }
    />
  );
};
