import { Upload } from "lucide-react";
import { useId } from "react";
import { Row } from "~/components/layout/row";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

/**
 * The drag-and-drop / file-picker surface for {@link CookbookImport}: accepts
 * `.epub` cookbooks (extracted with AI) and a power-user JSON export path. All
 * file handling lives in the parent; this is the relocated dropzone chrome.
 */
export function CookbookDropzone({
  isDragging,
  onDragStateChange,
  onDrop,
  onEpubFiles,
  onJsonFile,
}: {
  isDragging: boolean;
  onDragStateChange: (dragging: boolean) => void;
  onDrop: (e: React.DragEvent) => void;
  onEpubFiles: (files: File[]) => void;
  onJsonFile: (file: File) => void;
}) {
  const fileInputId = useId();
  const jsonInputId = useId();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop zone
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onDragStateChange(true);
      }}
      onDragLeave={() => onDragStateChange(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center gap-2 rounded border border-border border-dashed p-6 text-muted-foreground transition-colors",
        isDragging && "border-warning bg-warning/10 text-accent-foreground",
      )}
    >
      <Upload className="h-6 w-6" />
      <p className="text-sm">Drag .epub cookbooks here, or choose files.</p>
      <Row align="center" justify="center" wrap gap="sm">
        <Label
          htmlFor={fileInputId}
          className="cursor-pointer rounded border border-border px-2 py-2 font-medium text-foreground text-sm hover:bg-muted"
        >
          Choose .epub files
        </Label>
        <Input
          id={fileInputId}
          type="file"
          accept=".epub,application/epub+zip"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onEpubFiles([...e.target.files]);
            e.target.value = "";
          }}
        />
        <Label
          htmlFor={jsonInputId}
          className="cursor-pointer text-muted-foreground text-xs underline hover:text-foreground"
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
