import { partitionEntityFiles } from "@cubby/schemas/image";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { FileText } from "lucide-react";
import { type FC, useMemo, useState } from "react";
import { DocumentViewerList } from "~/app/_components/DocumentViewerList";
import EntityImageList from "~/app/_components/EntityImageList";
import {
  type PendingDocument,
  PendingDocumentUpload,
} from "~/app/_components/PendingDocumentUpload";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { useActionMutation } from "../_components/hooks/useActionMutation";

/**
 * A charge's paper trail: the emailed PDF invoice, the photo of the paper slip.
 *
 * PDFs and images share one relation (`PurchaseImage`), so `partitionEntityFiles`
 * splits them on `contentType` — a PDF handed to the image grid renders as a
 * broken thumbnail. Documents get the same inline `<iframe>` viewer a product's
 * manuals do (`DocumentViewerList`), reused rather than re-derived; its
 * `ViewableDocument` prop takes the minimal `{id,url,filename}` shape
 * `purchaseOut.images` already carries, so nothing has to be hydrated first.
 *
 * Saves are immediate rather than batched behind a Save button, matching the rest
 * of this page (every Overview field is an inline `EditableCell`): an upload
 * attaches on completion, a removal detaches on click.
 */
export const PurchaseDocuments: FC<{ purchase: PurchaseOut }> = ({
  purchase,
}) => {
  const api = useTRPC();
  const { images, documents } = useMemo(
    () => partitionEntityFiles(purchase.images),
    [purchase.images],
  );

  /**
   * `PendingDocumentUpload` owns its pending list and only clears it on remount —
   * the render-time prop sync inside it resets the *existing* set and the removal
   * list, never the uploads. After a save the document comes back on
   * `purchase.images`, which feeds `existingDocuments` below, so without a remount
   * the widget would list it twice: once as a pending row, once as an existing
   * one. Bumped per successful save.
   */
  const [saveGeneration, setSaveGeneration] = useState(0);

  const saveDocuments = useActionMutation({
    mutationFn: api.purchase.update.mutationOptions,
    success: "Documents updated",
    invalidateKeys: purchaseMutationInvalidateKeys,
    onSuccess: () => setSaveGeneration((n) => n + 1),
  });

  const attachedIds = useMemo(
    () => new Set(purchase.images.map((file) => file.id)),
    [purchase.images],
  );

  /**
   * The widget's removable rows. `purchaseOut.images` carries every field
   * `PendingDocument` needs (`key` included, which nothing renders — see its
   * schema comment); `size` isn't on the summary, so the row's file-size chip
   * just hides. PDFs only — the upload widget is `accept`-restricted to PDF, so
   * a non-PDF image can only arrive via MCP `attach_file`, and it gets its
   * detach control from `EntityImageList`'s `onRemove` below instead.
   */
  const existingDocuments = useMemo<PendingDocument[]>(
    () =>
      documents.map((doc) => ({
        id: doc.id,
        url: doc.url,
        filename: doc.filename,
        key: doc.key,
      })),
    [documents],
  );

  return (
    <Stack gap="md">
      {documents.length > 0 && <DocumentViewerList documents={documents} />}

      {images.length > 0 && (
        <EntityImageList
          images={images}
          showViewAllButton={false}
          // Non-PDF images reach a charge only through MCP `attach_file` (the
          // upload widget accepts PDF only), so this is their sole detach path.
          // Same server field the PDF removal uses — `removeImageIds`, handled
          // by `syncPurchaseImages` — and re-sending an already-detached id is a
          // no-op there, so a double click can't error.
          onRemove={(imageId) =>
            saveDocuments.mutate({
              id: purchase.id,
              data: { removeImageIds: [imageId] },
            })
          }
        />
      )}

      {purchase.images.length === 0 && (
        <Empty variant="minimal" className="py-4">
          <EmptyMedia variant="icon">
            <FileText className="size-4" />
          </EmptyMedia>
          <EmptyTitle>No documents</EmptyTitle>
          <EmptyDescription>
            The invoice, receipt or paper slip that documents this charge.
          </EmptyDescription>
        </Empty>
      )}

      {/* `folder` is the charge id, so R2 keys read as
          .../documents/<purchaseId>/invoice.pdf. */}
      <PendingDocumentUpload
        label="Invoices & receipts (PDF)"
        dropLabel="Drop an invoice or receipt PDF here"
        key={saveGeneration}
        entityType="PURCHASE"
        folder={purchase.id}
        existingDocuments={existingDocuments}
        onDocumentsChange={(pending) => {
          // Only ids that aren't filed yet: the widget reports its WHOLE pending
          // list on every upload, and `associatePendingImages` inserts with no
          // on-conflict clause — a re-sent id trips the (purchaseId, imageId)
          // unique index rather than no-opping.
          const pendingImageIds = pending
            .map((doc) => doc.id)
            .filter((id) => !attachedIds.has(id));
          if (pendingImageIds.length === 0) return;
          saveDocuments.mutate({
            id: purchase.id,
            data: { pendingImageIds },
          });
        }}
        onExistingDocumentsRemove={(removeImageIds) => {
          if (removeImageIds.length === 0) return;
          // The widget reports the cumulative removal list, which is fine here:
          // the server deletes with `WHERE imageId IN (…)`, so re-sending an
          // already-detached id is a no-op rather than an error.
          saveDocuments.mutate({
            id: purchase.id,
            data: { removeImageIds },
          });
        }}
      />
      <Description size="xs">
        Emailed PDF invoices and photos of paper slips. Amounts never come from
        a document — every dollar lives on the charge's expense lines.
      </Description>
    </Stack>
  );
};
