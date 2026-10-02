import { useId } from "react";

import { FileDropField } from "~/ui/file-upload/FileDropField";
import { Row } from "~/ui/layout/row";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";

/**
 * The drag-and-drop / file-picker surface for {@link CookbookImport}: accepts
 * `.epub` cookbooks (extracted with AI) and a power-user JSON export path. All
 * file handling lives in the parent; this is the relocated dropzone chrome.
 */
export function CookbookDropzone({
  onEpubFiles,
  onJsonFile,
  onBundleFile,
}: {
  onEpubFiles: (files: File[]) => void;
  onJsonFile: (file: File) => void;
  onBundleFile: (file: File) => void;
}) {
  const jsonInputId = useId();

  return (
    <div>
      <FileDropField
        accept=".epub,.cookbook,application/epub+zip"
        label="Drop .epub or .cookbook files here"
        description="or choose files"
        multiple
        onFilesAdded={(files) => {
          for (const file of files.filter((file) =>
            /\.cookbook$/i.test(file.name),
          ))
            onBundleFile(file);
          const epubs = files.filter((file) => /\.epub$/i.test(file.name));
          if (epubs.length) onEpubFiles(epubs);
        }}
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
