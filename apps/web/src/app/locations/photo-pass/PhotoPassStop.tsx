/**
 * One stop in the photo pass: the location in front of you, what it already
 * looks like, and a camera button.
 *
 * Phone-first — the capture button is a full-width 14-unit target and the shot
 * commits on selection, so the whole stop is one tap once you are standing
 * there. `capture="environment"` opens the rear camera directly on iOS Safari
 * rather than the photo library.
 */

import { isDisplayableImageFile } from "@cubby/schemas/image";
import { CameraIcon } from "@phosphor-icons/react/dist/csr/Camera";
import { SkipForwardIcon } from "@phosphor-icons/react/dist/csr/SkipForward";
import { useRef } from "react";

import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";

import type { PhotoStop } from "./photo-pass-utils";

export function PhotoPassStop({
  stop,
  position,
  total,
  isCapturing,
  onCapture,
  onSkip,
}: {
  stop: PhotoStop;
  position: number;
  total: number;
  isCapturing: boolean;
  onCapture: (file: File) => void;
  onSkip: () => void;
}) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const cover = stop.images.find(isDisplayableImageFile);
  const parentPath = stop.path.slice(0, -1);

  return (
    <Card>
      <CardContent className="px-4 py-4">
        <Stack gap="md">
          <Stack gap="xs">
            {parentPath.length > 0 && (
              <Description className="truncate">
                {parentPath.join(" › ")}
              </Description>
            )}
            <Row align="center" gap="sm" justify="between">
              <Row align="center" gap="sm" className="min-w-0">
                <LocationIcon
                  type={stop.type}
                  product={null}
                  size={18}
                  colored
                />
                <h2 className="my-0 min-w-0 truncate font-heading text-base font-semibold">
                  {stop.name}
                </h2>
              </Row>
              <Badge variant="outline" className="shrink-0 tabular-nums">
                {position} / {total}
              </Badge>
            </Row>
          </Stack>

          {cover ? (
            <Stack gap="xs">
              <Image
                src={cover.url}
                alt={`Current photo of ${stop.name}`}
                displayWidth={640}
                className="max-h-64 w-full rounded-md object-cover"
              />
              <Description>
                {stop.images.filter(isDisplayableImageFile).length === 1
                  ? "Current photo. A new shot becomes the cover; this one is kept."
                  : `Current cover of ${stop.images.filter(isDisplayableImageFile).length} photos. A new shot goes in front; these are kept.`}
              </Description>
            </Stack>
          ) : (
            <Description>No photo yet.</Description>
          )}

          {stop.aiDescription && (
            <Description className="line-clamp-3 italic">
              {stop.aiDescription}
            </Description>
          )}

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Clear first so re-picking the same file still fires `change`.
              event.target.value = "";
              if (file) onCapture(file);
            }}
          />

          <Row gap="sm">
            <Button
              type="button"
              className="h-14 flex-1 text-base"
              disabled={isCapturing}
              onClick={() => cameraInputRef.current?.click()}
            >
              {isCapturing ? (
                <Spinner className="mr-2 size-5" />
              ) : (
                <CameraIcon className="mr-2 size-5" />
              )}
              {cover ? "Retake photo" : "Take photo"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-14"
              disabled={isCapturing}
              onClick={onSkip}
            >
              <SkipForwardIcon className="mr-2 size-4" />
              Skip
            </Button>
          </Row>
        </Stack>
      </CardContent>
    </Card>
  );
}
