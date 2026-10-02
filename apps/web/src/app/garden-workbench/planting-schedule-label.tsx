import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import type { EntityRef } from "@cubby/schemas/entity";
import { plantingGuides } from "@cubby/schemas/garden-guides";
import { useCallback, useMemo } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import type { ScheduleRow } from "~/features/schedule/schedule-grid";

export function usePlantingScheduleLabel(
  rows: readonly ScheduleRow[],
  plantings: readonly { id: string; displayImages: DisplayImageSummary[] }[],
) {
  const seeded = useMemo(
    () =>
      Object.fromEntries(
        plantings.map((planting) => [
          entityDisplayImageKey({
            entityKind: "planting",
            entityId: planting.id,
          }),
          planting.displayImages[0] ?? null,
        ]),
      ),
    [plantings],
  );
  const refs = useMemo<EntityRef[]>(
    () =>
      rows.flatMap((row) =>
        row.id.startsWith("location:") && row.id !== "location:unplaced"
          ? [{ entityKind: "location", entityId: row.id.slice(9) }]
          : [],
      ),
    [rows],
  );
  const images = useEntityDisplayImages(refs, seeded);
  return useCallback(
    (row: ScheduleRow) => {
      if (row.id.startsWith("guide:")) {
        const source = plantingGuides.sources.find(
          (entry) => entry.id === row.id.split(":")[2],
        );
        if (source)
          return (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              title={source.name}
              className="min-w-0 truncate text-primary hover:underline focus-visible:underline"
            >
              {source.name}
            </a>
          );
      }
      if (row.id.startsWith("planting:")) {
        const id = row.id.slice("planting:".length);
        return (
          <EntityRefLink
            entity="planting"
            data={{ id, name: row.name }}
            displayImage={
              images[
                entityDisplayImageKey({ entityKind: "planting", entityId: id })
              ] ?? null
            }
            truncate
          />
        );
      }
      if (row.id.startsWith("location:") && row.id !== "location:unplaced") {
        const id = row.id.slice("location:".length);
        return (
          <EntityRefLink
            entity="location"
            data={{ id, name: row.name }}
            displayImage={
              images[
                entityDisplayImageKey({ entityKind: "location", entityId: id })
              ] ?? null
            }
            truncate
          />
        );
      }
      return row.name;
    },
    [images],
  );
}
