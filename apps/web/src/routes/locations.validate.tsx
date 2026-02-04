import { createFileRoute } from "@tanstack/react-router";
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
  parentId: z.string().optional(),
});

export const Route = createFileRoute("/locations/validate")({
  validateSearch: searchSchema,
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
