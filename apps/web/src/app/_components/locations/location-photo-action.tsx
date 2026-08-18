import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
import { Camera } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { useLocationPhotoCapture } from "./use-location-photo-capture";

/** Direct in-hand cover capture for the canonical Location detail page. */
export function LocationPhotoAction({
  location,
  className,
}: {
  location: InfLocation;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { capture, discardCapture, isCapturing } = useLocationPhotoCapture();
  const hasPhoto = location.images.some(isDisplayableImageFile);

  const takePhoto = async (file: File) => {
    try {
      const imageId = await capture(location.id, file);
      toast.success("Photo attached.", {
        action: {
          label: "Retake",
          onClick: () => {
            void discardCapture(location.id, imageId).catch((error: unknown) =>
              toast.error(`Retake failed: ${getErrorMessage(error)}`),
            );
          },
        },
      });
    } catch (error) {
      toast.error(`Photo failed: ${getErrorMessage(error)}`);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void takePhoto(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        disabled={isCapturing}
        onClick={() => inputRef.current?.click()}
      >
        {isCapturing ? <Spinner className="size-4" /> : <Camera />}
        {hasPhoto ? "Retake photo" : "Photo"}
      </Button>
    </>
  );
}
