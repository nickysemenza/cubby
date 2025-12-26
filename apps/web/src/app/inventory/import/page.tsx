import CSVImportForm from "./csv-import-form";

export default function ImportPage() {
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
