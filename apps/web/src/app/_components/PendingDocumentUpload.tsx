import type { EntityImage } from "@cubby/schemas/entity";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { useMutation } from "@tanstack/react-query";
import { FileText, X } from "lucide-react";
import prettyBytes from "pretty-bytes";
import { useCallback, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import type { PendingImage } from "./PendingImageUpload";

/** A document row — the PendingImage shape plus the file size for display. */
export interface PendingDocument extends PendingImage {
  size?: number;
}

const EMPTY_DOCUMENTS: PendingDocument[] = [];

interface PendingDocumentUploadProps {
  entityType: EntityImage;
  /**
   * R2 key folder for uploaded documents — the owning entity's shortcode
   * (e.g. "P-0123") so URLs read as .../documents/P-0123/manual.pdf. Omit in
   * create mode (no shortcode yet); uploads land in the plain documents/ root.
   */
  folder?: string;
  onDocumentsChange?: (documents: PendingDocument[]) => void;
  existingDocuments?: PendingDocument[];
  onExistingDocumentsRemove?: (removedDocumentIds: string[]) => void;
}

function DocumentRow({
  document,
  onRemove,
}: {
  document: PendingDocument;
  onRemove: () => void;
}) {
  return (
    <Row
      align="center"
      gap="sm"
      className="min-w-0 border border-[var(--border)] px-2 py-1"
    >
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">
        {document.filename}
      </span>
      {document.size != null && document.size > 0 && (
        <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
          {prettyBytes(document.size)}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <X className="h-4 w-4" />
      </Button>
    </Row>
  );
}

/**
 * PDF manual uploads. Documents ride the pending-image machinery (same table,
 * same association path) but get their own component — PendingImageUpload is
 * image-shaped (camera, paste, URL import, cover/reorder), none of which
 * applies here.
 */
export function PendingDocumentUpload({
  entityType,
  folder,
  onDocumentsChange,
  existingDocuments = EMPTY_DOCUMENTS,
  onExistingDocumentsRemove,
}: PendingDocumentUploadProps) {
  const documentInputId = useId();
  const [uploading, setUploading] = useState(false);
  const [pendingDocuments, setPendingDocuments] = useState<PendingDocument[]>(
    [],
  );
  // Seed from the prop; the render-time sync below only fires when the prop
  // IDENTITY changes (parent refetch) — same pattern as PendingImageUpload.
  const [currentExistingDocuments, setCurrentExistingDocuments] =
    useState<PendingDocument[]>(existingDocuments);
  const [removedExistingDocumentIds, setRemovedExistingDocumentIds] = useState<
    string[]
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const api = useTRPC();

  const [prevExistingDocuments, setPrevExistingDocuments] =
    useState(existingDocuments);
  if (existingDocuments !== prevExistingDocuments) {
    setPrevExistingDocuments(existingDocuments);
    setCurrentExistingDocuments(existingDocuments);
    setRemovedExistingDocumentIds([]);
  }

  const uploadDocumentMutation = useMutation(
    api.image.uploadDocument.mutationOptions({
      onError: (error) => {
        toast.error(`Upload initialization failed: ${getErrorMessage(error)}`);
      },
    }),
  );

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (file.type !== PDF_CONTENT_TYPE) {
        toast.error(`Unsupported file type: ${file.type}. PDF only.`);
        return;
      }

      setUploading(true);
      try {
        const initResult = await uploadDocumentMutation.mutateAsync({
          filename: file.name,
          contentType: PDF_CONTENT_TYPE,
          size: file.size,
          entityType,
          folder,
        });

        const uploadResult = await fetch(initResult.uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": PDF_CONTENT_TYPE },
        });
        if (!uploadResult.ok) {
          const errorText = await uploadResult
            .text()
            .catch(() => "Unknown error");
          throw new Error(
            `Storage error (${uploadResult.status}): ${errorText}`,
          );
        }

        const newDocument: PendingDocument = {
          id: initResult.imageId,
          url: initResult.url,
          filename: file.name,
          key: initResult.key,
          size: file.size,
        };
        const updated = [...pendingDocuments, newDocument];
        setPendingDocuments(updated);
        onDocumentsChange?.(updated);
        toast.success("Manual added.");
      } catch (error) {
        toast.error(`Upload failed: ${getErrorMessage(error)}`);
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [
      entityType,
      folder,
      uploadDocumentMutation,
      pendingDocuments,
      onDocumentsChange,
    ],
  );

  const removePendingDocument = useCallback(
    (documentId: string) => {
      const updated = pendingDocuments.filter((doc) => doc.id !== documentId);
      setPendingDocuments(updated);
      onDocumentsChange?.(updated);
    },
    [pendingDocuments, onDocumentsChange],
  );

  const removeExistingDocument = useCallback(
    (documentId: string) => {
      const updatedRemovedIds = [...removedExistingDocumentIds, documentId];
      setRemovedExistingDocumentIds(updatedRemovedIds);
      setCurrentExistingDocuments(
        currentExistingDocuments.filter((doc) => doc.id !== documentId),
      );
      onExistingDocumentsRemove?.(updatedRemovedIds);
    },
    [
      removedExistingDocumentIds,
      currentExistingDocuments,
      onExistingDocumentsRemove,
    ],
  );

  return (
    <Stack gap="sm">
      <Label htmlFor={documentInputId}>Manuals (PDF)</Label>
      <Input
        ref={fileInputRef}
        id={documentInputId}
        type="file"
        accept="application/pdf"
        onChange={handleFileUpload}
        disabled={uploading}
      />
      {uploading && <p className="text-muted-foreground text-xs">Uploading…</p>}
      {(pendingDocuments.length > 0 || currentExistingDocuments.length > 0) && (
        <Stack gap="xs">
          {currentExistingDocuments.map((doc) => (
            <DocumentRow
              key={doc.id}
              document={doc}
              onRemove={() => removeExistingDocument(doc.id)}
            />
          ))}
          {pendingDocuments.map((doc) => (
            <DocumentRow
              key={doc.id}
              document={doc}
              onRemove={() => removePendingDocument(doc.id)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
