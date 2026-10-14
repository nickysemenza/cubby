import type { Entity } from "@cubby/schemas/entity";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type FC, useEffect, useMemo } from "react";
import { z } from "zod";

import { useDebug } from "~/ui/hooks/useDebug";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { usePageDetailContext } from "~/ui/page/Page";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/primitives/card";

import {
  EntityRelations,
  supportsEntityGraph,
} from "../../entity/relationships/entity-relations";
import { relationshipsSectionIcon } from "../../entity/relationships/relationship-tree";
import { AuditLogList } from "../../features/audit-log/audit-log-list";
import JsonRenderer from "../json-renderer";
import {
  type IndexedSection,
  IndexedSections,
  type IndexedSectionGroup,
  normalizedHash,
  SectionStack,
} from "./indexed-sections";

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
  /** `false` places the section in Evidence unless an explicit workspace owns it. */
  overview?: boolean;
  workspace?: "overview" | "work" | "evidence" | "relations";
  /** Specialized workflows can supply their own internal surface while retaining
   * the shared index, relationship, activity, and debug extensions. */
  surface?: "card" | "plain";
}

interface DetailSectionsProps {
  onlyWorkspace?: "evidence";
  sections: DetailSection[];
  rawData: unknown;
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

export const DetailSections: FC<DetailSectionsProps> = ({
  onlyWorkspace,
  sections,
  rawData,
}) => {
  const hydrated = useHydrated();
  const locationHash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
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
  const groups = useMemo(() => {
    const groupSections = (
      workspace: "overview" | "work" | "evidence" | "relations",
    ) =>
      sections.filter(
        (section) =>
          section.id !== RELATIONS_SECTION_ID &&
          section.id !== ACTIVITY_SECTION_ID &&
          (section.workspace ??
            (section.overview === false ? "evidence" : "overview")) ===
            workspace,
      );
    const result: IndexedSectionGroup[] = [
      {
        id: "detail-group-overview",
        title: "Overview",
        sections: groupSections("overview"),
      },
      {
        id: "detail-group-work",
        title: "Work",
        sections: groupSections("work"),
      },
      {
        id: "detail-group-evidence",
        title: "Evidence",
        sections: groupSections("evidence"),
      },
      {
        id: "detail-group-relations",
        title: "Relations",
        sections: [
          ...groupSections("relations"),
          ...(relationship.section ? [relationship.section] : []),
        ],
      },
      {
        id: "detail-group-activity",
        title: "Activity",
        sections: activity.section ? [activity.section] : [],
      },
    ];
    return result.filter((group) => group.sections.length > 0);
  }, [sections, relationship.section, activity.section]);
  useEffect(() => {
    if (!hydrated || onlyWorkspace !== "evidence" || !locationHash) return;
    const id = normalizedHash(locationHash);
    if (
      id === "evidence" ||
      sections.some(
        (section) => section.workspace === "evidence" && section.id === id,
      )
    )
      return;
    void navigate({
      to: ".",
      search: true,
      hash: "",
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  }, [hydrated, onlyWorkspace, locationHash, sections, navigate]);
  if (onlyWorkspace === "evidence")
    return (
      <div className="space-y-2" data-run-evidence>
        <SectionStack
          sections={sections.filter(
            (section) => section.workspace === "evidence",
          )}
        />
      </div>
    );
  return (
    <IndexedSections
      groups={groups}
      footer={
        isDebugEnabled && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle as="h2">Raw Details</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonRenderer input={rawData} pretty />
            </CardContent>
          </Card>
        )
      }
    />
  );
};
