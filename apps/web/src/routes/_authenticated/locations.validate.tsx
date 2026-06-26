import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { LocationValidateForm } from "~/app/locations/validate/location-validate-form";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  parentId: z.string().optional().catch(undefined),
});

const searchDefaults = { parentId: undefined } as const;

export const Route = createFileRoute("/_authenticated/locations/validate")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: LocationValidatePage,
});

function LocationValidatePage() {
  const { parentId } = Route.useSearch();

  return (
    <Page
      variant="list"
      title="Validate location"
      eyebrow="Locations"
      compact
      decoration="none"
    >
      <LocationValidateForm initialParentId={parentId} />
    </Page>
  );
}
