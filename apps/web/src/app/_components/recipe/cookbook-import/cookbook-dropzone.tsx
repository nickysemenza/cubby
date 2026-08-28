import { useId } from "react";

import { FileDropField } from "~/components/file-upload/FileDropField";
import { Row } from "~/components/layout/row";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

/**
 * The drag-and-drop / file-picker surface for {@link CookbookImport}: accepts
 * `.epub` cookbooks (extracted with AI) and a power-user JSON export path. All
 * file handling lives in the parent; this is the relocated dropzone chrome.
 */
export function CookbookDropzone({
  onEpubFiles,
  onJsonFile,
}: {
  onEpubFiles: (files: File[]) => void;
  onJsonFile: (file: File) => void;
}) {
  const jsonInputId = useId();

  return (
    <div>
      <FileDropField
        accept=".epub,application/epub+zip"
        label="Drop .epub cookbooks here"
        description="or choose files"
        multiple
        onFilesAdded={onEpubFiles}
      />
      <Row align="center" justify="center" wrap gap="sm">
        <Label
          htmlFor={jsonInputId}
          className="cursor-pointer text-xs text-muted-foreground underline hover:text-foreground"
        >
          or import JSON
        </Label>
        <Input
          id={jsonInputId}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onJsonFile(file);
            e.target.value = "";
          }}
        />
      </Row>
    </div>
  );
}
