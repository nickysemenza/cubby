import { createFileRoute } from "@tanstack/react-router";
import CSVImportForm from "~/app/inventory/import/csv-import-form";

export const Route = createFileRoute("/inventory/import")({
  component: ImportPage,
});

function ImportPage() {
  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <h1 className="font-bold text-2xl">Import Inventory from CSV</h1>
        <p className="text-muted-foreground">
          Paste data from Google Sheets or upload a CSV file. Preview updates
          automatically.
        </p>
      </div>
      <CSVImportForm />
    </div>
  );
}
