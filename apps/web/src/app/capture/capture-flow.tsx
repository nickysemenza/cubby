import type { ProposedItem } from "@cubby/schemas/capture";
import type { AllowedImageType } from "@cubby/schemas/image";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { Camera, Check, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  amountField,
  getLocationId,
  getProductId,
  requiredLocationField,
  requiredProductField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { PageHero } from "~/components/layouts/page-hero";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { useTRPC } from "~/trpc/react";

const confidenceVariant = {
  high: "secondary",
  medium: "outline",
  low: "outline",
} as const;

export function CaptureFlow() {
  const api = useTRPC();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const uploadImage = useMutation(api.image.uploadImage.mutationOptions());
  const analyze = useMutation(
    api.capture.analyze.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );

  const handleFile = async (file: File) => {
    setUploading(true);
    setImageUrl(null);
    analyze.reset();
    try {
      const init = await uploadImage.mutateAsync({
        filename: file.name,
        contentType: file.type as AllowedImageType,
        size: file.size,
        entityType: "PRODUCT", // photo isn't linked to an entity; just stored for vision
      });
      const put = await fetch(init.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error("Image upload failed");
      setImageUrl(init.url);
      analyze.mutate({ imageId: init.imageId });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const busy = uploading || analyze.isPending;
  const proposals = analyze.data?.proposedItems ?? [];

  return (
    <PageWrapper className="space-y-6">
      <PageHero
        variant="list"
        eyebrow="Beta"
        title="Scan a shelf"
        meta={[
          { icon: Sparkles, label: "Photograph items and add them in bulk" },
        ]}
      />

      {/* Hidden capture input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />

      {/* Photo preview / upload prompt */}
      {imageUrl ? (
        <div className="overflow-hidden rounded-xl border border-border/50">
          <Image
            src={imageUrl}
            alt="Captured shelf"
            className="max-h-64 w-full object-cover"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-border border-dashed py-16 text-muted-foreground transition-colors hover:bg-muted/40"
        >
          <Camera className="h-8 w-8" />
          <span className="font-medium text-sm">
            Take or choose a photo of a shelf
          </span>
        </button>
      )}

      {/* Analyzing */}
      {busy && (
        <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
          <Spinner />
          {uploading ? "Uploading photo…" : "Analyzing photo…"}
        </div>
      )}

      {/* Review */}
      {!busy && analyze.data && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-heading font-semibold text-xl">
              {proposals.length} item{proposals.length === 1 ? "" : "s"} found
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Camera className="mr-1 h-4 w-4" />
              New photo
            </Button>
          </div>
          {analyze.data.summary && (
            <p className="text-muted-foreground text-sm">
              {analyze.data.summary}
            </p>
          )}

          {proposals.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No items detected in this photo.
            </p>
          ) : (
            <div className="space-y-2">
              {proposals.map((item, i) => (
                <CaptureItemCard
                  // biome-ignore lint/suspicious/noArrayIndexKey: proposals are a stable positional list for this render
                  key={i}
                  proposal={item}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </PageWrapper>
  );
}

const itemFormSchema = z.object({
  product: requiredProductField,
  location: requiredLocationField,
  amount: amountField,
});
type ItemFormValues = z.input<typeof itemFormSchema>;

function CaptureItemCard({ proposal }: { proposal: ProposedItem }) {
  const api = useTRPC();
  const [added, setAdded] = useState(false);

  const form = useForm<ItemFormValues>({
    resolver: zodResolver(itemFormSchema),
    defaultValues: {
      product: undefined,
      location: undefined,
      amount: { value: proposal.quantity, unit: proposal.unit },
    },
  });

  const create = useMutation(
    api.inventory.create.mutationOptions({
      onSuccess: () => {
        toast.success(`Tucked ${proposal.name} into your cubby.`);
        setAdded(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const onSubmit = (values: ItemFormValues) => {
    create.mutate({
      productId: getProductId(values.product),
      locationId: getLocationId(values.location),
      amount: values.amount,
    });
  };

  const meta = [
    isUnspecifiedManufacturer(proposal.manufacturer)
      ? null
      : proposal.manufacturer,
    `${proposal.quantity} ${proposal.unit}`,
  ]
    .filter(Boolean)
    .join(" · ");

  if (added) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-2 text-muted-foreground text-sm">
        <Check className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate">Added {proposal.name} to inventory</span>
      </div>
    );
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="space-y-2 rounded-lg border border-border/50 p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium text-sm">{proposal.name}</span>
          {meta && (
            <span className="ml-1.5 text-muted-foreground text-xs">{meta}</span>
          )}
        </div>
        <Badge variant={confidenceVariant[proposal.confidence]}>
          {proposal.confidence}
        </Badge>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[8rem] flex-[3]">
          <ComboboxFieldWithSearch
            form={form}
            name="product"
            label="Product"
            searchType="product"
          />
        </div>
        <div className="min-w-[8rem] flex-[3]">
          <ComboboxFieldWithSearch
            form={form}
            name="location"
            label="Location"
            searchType="location"
          />
        </div>
        <div className="min-w-[7rem] flex-[2]">
          <AmountFieldGroup
            form={form}
            valuePath="amount.value"
            unitPath="amount.unit"
            compact
          />
        </div>
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? <Spinner className="mr-1" /> : null}
          Add
        </Button>
      </div>
    </form>
  );
}
