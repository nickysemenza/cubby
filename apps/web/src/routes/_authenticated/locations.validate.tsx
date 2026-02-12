import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { LocationValidateForm } from "~/app/locations/validate/location-validate-form";
import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

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
    <PageWrapper>
      <Card>
        <CardHeader>
          <CardTitle>Validate Location</CardTitle>
          <CardDescription>
            Scan QR codes on child locations to verify they are where the system
            expects them
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LocationValidateForm initialParentId={parentId} />
        </CardContent>
      </Card>
    </PageWrapper>
  );
}
