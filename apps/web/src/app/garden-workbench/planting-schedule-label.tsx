import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import type { EntityRef } from "@cubby/schemas/entity";
import { plantingGuides } from "@cubby/schemas/garden-guides";
import { useCallback, useMemo } from "react";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import type { ScheduleRow } from "~/app/_components/schedule/schedule-grid";

export function usePlantingScheduleLabel(
  rows: readonly ScheduleRow[],
  plantings: readonly { id: string; displayImages: DisplayImageSummary[] }[],
) {
  const seeded = useMemo(
    () =>
      Object.fromEntries(
        plantings.map((planting) => [
          entityDisplayImageKey({
            entityType: "planting",
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
          ? [{ entityType: "location", entityId: row.id.slice(9) }]
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
          <EntityInlineLink
            entity="planting"
            data={{ id, name: row.name }}
            displayImage={
              images[
                entityDisplayImageKey({ entityType: "planting", entityId: id })
              ] ?? null
            }
            truncate
          />
        );
      }
      if (row.id.startsWith("location:") && row.id !== "location:unplaced") {
        const id = row.id.slice("location:".length);
        return (
          <EntityInlineLink
            entity="location"
            data={{ id, name: row.name }}
            displayImage={
              images[
                entityDisplayImageKey({ entityType: "location", entityId: id })
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
