import type { AllowedImageType } from "@cubby/schemas/image";
import { useMutation } from "@tanstack/react-query";
import { Camera, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC } from "~/trpc/react";
import { CaptureItemCard } from "./CaptureItemCard";

export function CaptureFlow() {
  const api = useTRPC();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const uploadImage = useMutation(api.image.uploadImage.mutationOptions());
  const analyze = useMutation(
    api.capture.analyze.mutationOptions({
      onError: (error) => toast.error(getErrorMessage(error)),
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
    <Page variant="list" eyebrow="Beta" title="Scan a shelf">
      <Stack gap="lg">
        {/* Meta strip — preserved from the old PageHero `meta` slot, which the
            unified <Page> header no longer exposes. */}
        <div className="-mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Sparkles className="h-3 w-3 shrink-0" />
            <span>Photograph items and add them in bulk</span>
          </span>
        </div>

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
          <Row
            align="center"
            justify="center"
            gap="sm"
            className="py-6 text-muted-foreground text-sm"
          >
            <Spinner />
            {uploading ? "Uploading photo…" : "Analyzing photo…"}
          </Row>
        )}

        {/* Review */}
        {!busy && analyze.data && (
          <Stack gap="sm">
            <Row align="center" justify="between">
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
            </Row>
            {analyze.data.summary && (
              <Description>{analyze.data.summary}</Description>
            )}

            {proposals.length === 0 ? (
              <Description>No items detected in this photo.</Description>
            ) : (
              <Stack gap="sm">
                {proposals.map((item, i) => (
                  <CaptureItemCard
                    // biome-ignore lint/suspicious/noArrayIndexKey: proposals are a stable positional list for this render
                    key={i}
                    proposal={item}
                  />
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Page>
  );
}
