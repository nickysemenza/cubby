import type { EntityRef } from "@cubby/schemas/entity";
import type { GeneratedGroupChoice } from "@cubby/schemas/entity-list-fields";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ListGroupBy, ListGroupSummary } from "@cubby/schemas/pagination";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { EntityIdentityMark } from "~/entity/components/entity-identity-mark";
import {
  EntityDisplayImagesProvider,
  entityDisplayImageKey,
  useEntityDisplayImageMap,
} from "~/entity/entity-media/entity-display-images";

const GroupChoicesContext = createContext<
  readonly (GeneratedGroupChoice | undefined)[]
>([]);

function groupRecordRef(
  choice: GeneratedGroupChoice | undefined,
  value: string,
): EntityRef | undefined {
  const record = choice?.value;
  return (record?.kind === "record" || record?.kind === "rowRecord") &&
    value !== FILTER_NONE
    ? { entityKind: record.target, entityId: value }
    : undefined;
}

/** Group summaries own identity-image batches, including unloaded nested groups. */
export function GroupLabelsProvider({
  grouping,
  groupBy,
  groups,
  children,
}: {
  grouping: readonly GeneratedGroupChoice[];
  groupBy: readonly ListGroupBy[] | undefined;
  groups: readonly Pick<ListGroupSummary, "path">[];
  children: ReactNode;
}) {
  const choices = useMemo(
    () =>
      (groupBy ?? []).map((dimension) =>
        dimension.bucket
          ? undefined
          : grouping.find((choice) => choice.key === dimension.key),
      ),
    [grouping, groupBy],
  );
  const refs = useMemo(
    () =>
      groups.flatMap((group) =>
        group.path.flatMap((value, depth) => {
          const ref = groupRecordRef(choices[depth], value);
          return ref ? [ref] : [];
        }),
      ),
    [choices, groups],
  );
  return (
    <GroupChoicesContext.Provider value={choices}>
      <EntityDisplayImagesProvider refs={refs}>
        {children}
      </EntityDisplayImagesProvider>
    </GroupChoicesContext.Provider>
  );
}

/** Identity is decorative; the existing control keeps its label and behavior. */
export function GroupValueLabel({
  depth,
  value,
  label,
}: {
  depth: number;
  value: string;
  label: string;
}) {
  const choices = useContext(GroupChoicesContext);
  const images = useEntityDisplayImageMap();
  const ref = groupRecordRef(choices[depth], value);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 align-middle">
      {ref && (
        <span aria-hidden className="inline-flex shrink-0">
          <EntityIdentityMark
            entity={ref.entityKind}
            id={ref.entityId}
            name={label}
            displayImage={images[entityDisplayImageKey(ref)] ?? null}
            size="compact"
            preview={false}
          />
        </span>
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}
