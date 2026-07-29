import { FileUp, Upload } from "lucide-react";
import { useCallback } from "react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useFileUpload } from "~/hooks/use-file-upload";
import { cn } from "~/lib/utils";

interface FileDropFieldProps {
  accept: string;
  disabled?: boolean;
  label: string;
  description?: string;
  maxFiles?: number;
  maxSize?: number;
  mode?: "compact" | "dropzone";
  multiple?: boolean;
  onFilesAdded: (files: File[]) => void;
}

export function FileDropField({
  accept,
  disabled = false,
  label,
  description,
  maxFiles,
  maxSize,
  mode = "dropzone",
  multiple = false,
  onFilesAdded,
}: FileDropFieldProps) {
  const handleFilesAdded = useCallback(
    (
      addedFiles: Array<{
        file: File | { name: string };
      }>,
    ) => {
      const files = addedFiles
        .map(({ file }) => file)
        .filter((file): file is File => file instanceof File);
      if (files.length > 0) onFilesAdded(files);
    },
    [onFilesAdded],
  );

  const [state, actions] = useFileUpload({
    accept,
    maxFiles,
    maxSize,
    multiple,
    onFilesAdded: handleFilesAdded,
  });

  const input = (
    <input
      {...actions.getInputProps({ disabled })}
      aria-label={label}
      className="sr-only"
    />
  );

  if (mode === "compact") {
    return (
      <Stack gap="xs">
        <Row align="center" gap="sm">
          {input}
          <Button
            type="button"
            variant="outline"
            onClick={actions.openFileDialog}
            disabled={disabled}
          >
            <FileUp />
            {label}
          </Button>
          {description && (
            <span className="text-muted-foreground text-xs">{description}</span>
          )}
        </Row>
        {state.errors.map((error) => (
          <p key={error} className="text-destructive text-xs">
            {error}
          </p>
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap="xs">
      {input}
      <button
        type="button"
        onClick={actions.openFileDialog}
        onDragEnter={actions.handleDragEnter}
        onDragLeave={actions.handleDragLeave}
        onDragOver={actions.handleDragOver}
        onDrop={actions.handleDrop}
        disabled={disabled}
        className={cn(
          "flex w-full flex-col items-center gap-2 border border-[var(--border)] border-dashed bg-muted/20 p-6 text-center text-muted-foreground transition-colors hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-50",
          state.isDragging &&
            "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20",
        )}
      >
        <Upload className="size-5" />
        <span className="font-medium text-foreground text-sm">{label}</span>
        {description && <span className="text-xs">{description}</span>}
      </button>
      {state.errors.map((error) => (
        <p key={error} className="text-destructive text-xs">
          {error}
        </p>
      ))}
    </Stack>
  );
}
