import { createFileRoute } from "@tanstack/react-router";
import LocationCSVImportForm from "~/app/locations/import/location-import-form";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/locations/import")({
  component: LocationImportPage,
});

function LocationImportPage() {
  return (
    <PageWrapper>
      <div className="mb-6">
        <h1 className="font-bold font-heading text-2xl">Import Locations</h1>
        <p className="text-muted-foreground">
          Import locations from a CSV file to quickly set up your storage
          structure.
        </p>
      </div>
      <LocationCSVImportForm />
    </PageWrapper>
  );
}
