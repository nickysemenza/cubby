import type {
  GardenGuideWindow,
  GardenGuidesDocument,
} from "@cubby/schemas/garden-guide";
import { useQuery } from "@tanstack/react-query";

import { Stack } from "~/components/layout";

import { garden } from "./garden.functions";

const monthsByNumber = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function gardenWindowLabel(window: GardenGuideWindow) {
  const part =
    window.monthPart === "weeks-1-2"
      ? " (weeks 1–2)"
      : window.monthPart === "weeks-3-4"
        ? " (weeks 3–4)"
        : "";
  return `${window.months.map((month) => monthsByNumber[month - 1]).join(", ")}${part}`;
}

function GardenGuideContent({
  document,
  guideKey,
}: {
  document: GardenGuidesDocument;
  guideKey: string;
}) {
  const guide = document.guides.find((candidate) => candidate.key === guideKey);
  if (!guide)
    return (
      <p className="text-sm text-muted-foreground">
        No planting guide is linked for this crop yet.
      </p>
    );
  return (
    <Stack gap="md">
      <h3 className="text-sm font-semibold">{guide.name} planting windows</h3>
      {guide.notes && <p className="text-sm">{guide.notes}</p>}
      {guide.windows.map((window) => {
        const source = document.sources.find(
          (candidate) => candidate.id === window.sourceId,
        );
        return (
          <Stack
            key={`${window.sourceId}-${window.microclimate}-${window.method}-${window.monthPart ?? "all"}-${window.months.join("-")}`}
            gap="sm"
            className="border-b pb-3 text-sm"
          >
            <p>
              <strong>{gardenWindowLabel(window)}</strong> ·{" "}
              {window.microclimate.replaceAll("-", " ")} ·{" "}
              {window.method === "unspecified"
                ? "Method unspecified"
                : window.method.replaceAll("-", " ")}
            </p>
            {window.notes && <p>{window.notes}</p>}
            {source && (
              <details className="text-muted-foreground">
                <summary className="cursor-pointer">{source.name}</summary>
                <Stack gap="sm" className="pt-2">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    View source
                  </a>
                  {source.publishedOrRevised && (
                    <p>Published/revised: {source.publishedOrRevised}</p>
                  )}
                  <p>Reviewed: {source.reviewedAt}</p>
                  {source.basedOn.length > 0 && (
                    <p>Based on: {source.basedOn.join("; ")}</p>
                  )}
                  {source.notes && <p>{source.notes}</p>}
                </Stack>
              </details>
            )}
          </Stack>
        );
      })}
      <p className="text-sm text-muted-foreground">
        Sources may differ. Use the windows as local context; your bed’s
        conditions still matter.
      </p>
    </Stack>
  );
}

export function GardenGuide({
  guideKey,
}: {
  guideKey: string | null | undefined;
}) {
  const guides = useQuery(garden.guides.queryOptions(undefined));
  if (!guideKey)
    return (
      <p className="text-sm text-muted-foreground">
        A planting guide can be linked when editing this crop’s garden details.
      </p>
    );
  if (guides.isPending)
    return <p className="text-sm">Loading planting guide…</p>;
  if (guides.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the guide. Your planting can still be saved.
      </p>
    );
  return <GardenGuideContent document={guides.data} guideKey={guideKey} />;
}
