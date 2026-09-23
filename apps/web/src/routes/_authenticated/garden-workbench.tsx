import { gardenCropKey } from "@cubby/schemas/garden-practice";
import { locationShortcode } from "@cubby/schemas/identifiers";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";

import { GardenWorkbench } from "~/app/garden-workbench/garden-workbench";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  mode: z.enum(["timing", "practice", "plan"]).optional().catch(undefined),
  year: z.coerce.number().int().min(2000).max(2100).optional().catch(undefined),
  crop: gardenCropKey.optional().catch(undefined),
  location: locationShortcode.optional().catch(undefined),
});

const searchDefaults = {
  mode: undefined,
  year: undefined,
  crop: undefined,
  location: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/garden-workbench")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("Garden workbench") }] }),
  component: GardenWorkbenchPage,
});

function GardenWorkbenchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const year = search.year ?? new Date().getUTCFullYear();
  return (
    <Page
      variant="list"
      title="Garden workbench"
      eyebrow="Plantings"
      layout="full"
    >
      <GardenWorkbench
        mode={search.mode ?? "timing"}
        year={year}
        crop={search.crop}
        location={search.location}
        onModeChange={(mode) =>
          void navigate({
            search: (previous) => ({ ...previous, mode }),
            replace: true,
          })
        }
        onYearChange={(nextYear) =>
          void navigate({
            search: (previous) => ({ ...previous, year: nextYear }),
            replace: true,
          })
        }
        onCropChange={(crop) =>
          void navigate({
            search: (previous) => ({ ...previous, crop }),
            replace: true,
          })
        }
        onLocationChange={(location) =>
          void navigate({
            search: (previous) => ({ ...previous, location }),
            replace: true,
          })
        }
      />
    </Page>
  );
}
