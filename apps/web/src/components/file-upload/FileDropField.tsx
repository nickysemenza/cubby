import { FileArrowUpIcon as FileUp } from "@phosphor-icons/react/dist/csr/FileArrowUp";
import { UploadIcon as Upload } from "@phosphor-icons/react/dist/csr/Upload";
import { useCallback, useState } from "react";
import { type Accept, type FileRejection, useDropzone } from "react-dropzone";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
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

function acceptedTypes(accept: string): Accept | undefined {
  if (!accept || accept === "*") return undefined;

  const types: Accept = {};
  const extensions: string[] = [];
  for (const entry of accept.split(",").map((value) => value.trim())) {
    if (!entry) continue;
    if (entry.startsWith(".")) extensions.push(entry);
    else types[entry] = [];
  }
  if (extensions.length > 0) types["application/octet-stream"] = extensions;
  return types;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "the configured limit";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${Number((bytes / 1024).toFixed(2))} KB`;
  return `${Number((bytes / 1024 ** 2).toFixed(2))} MB`;
}

function rejectionMessages(
  rejections: FileRejection[],
  options: { maxFiles?: number; maxSize?: number; multiple: boolean },
): string[] {
  return [
    ...new Set(
      rejections.flatMap(({ file, errors }) =>
        errors.map((error) => {
          switch (error.code) {
            case "file-invalid-type":
              return `File "${file.name}" is not an accepted file type.`;
            case "file-too-large":
              return options.multiple
                ? `Some files exceed the maximum size of ${formatBytes(options.maxSize ?? Number.POSITIVE_INFINITY)}.`
                : `File exceeds the maximum size of ${formatBytes(options.maxSize ?? Number.POSITIVE_INFINITY)}.`;
            case "too-many-files":
              return `You can only upload a maximum of ${options.maxFiles ?? 1} files.`;
            default:
              return error.message;
          }
        }),
      ),
    ),
  ];
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
  const [errors, setErrors] = useState<string[]>([]);
  const onDrop = useCallback(
    (files: File[], rejections: FileRejection[]) => {
      setErrors(rejectionMessages(rejections, { maxFiles, maxSize, multiple }));
      if (files.length > 0) onFilesAdded(files);
    },
    [maxFiles, maxSize, multiple, onFilesAdded],
  );
  const { getInputProps, getRootProps, isDragActive, open } = useDropzone({
    maxFiles,
    maxSize,
    multiple,
    accept: acceptedTypes(accept),
    disabled,
    noClick: mode === "compact",
    onDrop,
  });

  const input = (
    <input
      {...getInputProps({
        "aria-label": label,
        className: "sr-only",
        disabled,
      })}
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
            onClick={open}
            disabled={disabled}
          >
            <FileUp />
            {label}
          </Button>
          {description && (
            <span className="text-xs text-muted-foreground">{description}</span>
          )}
        </Row>
        {errors.map((error) => (
          <p key={error} className="text-xs text-destructive">
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
        {...getRootProps({
          type: "button",
          role: "button",
          "aria-label": label,
        })}
        disabled={disabled}
        className={cn(
          "flex w-full flex-col items-center gap-2 border border-dashed border-[var(--border)] bg-muted/20 p-6 text-center text-muted-foreground transition-colors hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-50",
          isDragActive &&
            "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20",
        )}
      >
        <Upload className="size-5" />
        <span className="text-sm font-medium text-foreground">{label}</span>
        {description && <span className="text-xs">{description}</span>}
      </button>
      {errors.map((error) => (
        <p key={error} className="text-xs text-destructive">
          {error}
        </p>
      ))}
    </Stack>
  );
}
