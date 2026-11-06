import type { RelatednessOut } from "@cubby/schemas/relatedness";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import { formatCount } from "~/lib/number-format";
import { RecordRow } from "~/ui/records/record-list";

export function RelatedRecordRow({
  item,
}: {
  item: RelatednessOut["items"][number];
}) {
  const displayImage = useEntityDisplayImage({
    entityKind: item.entity,
    entityId: item.shortcode,
  });
  return (
    <RecordRow
      primary={
        <EntityRefLink
          entity={item.entity}
          id={item.shortcode}
          name={item.title}
          displayImage={displayImage}
        />
      }
      secondary={item.evidence
        .map((evidence) =>
          evidence.detail
            ? `${evidence.signal}: ${evidence.detail}`
            : evidence.signal,
        )
        .join(" · ")}
      trailing={
        item.score > 0 ? (
          <span
            className="font-mono text-xs tabular-nums"
            aria-label={`Relatedness score ${formatCount(item.score, 2)}`}
          >
            {formatCount(item.score, 2)}
          </span>
        ) : null
      }
    />
  );
}
