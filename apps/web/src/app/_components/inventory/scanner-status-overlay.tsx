import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CameraSlashIcon } from "@phosphor-icons/react/dist/csr/CameraSlash";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";

type ScannerStatusOverlayProps =
  | {
      status: "loading";
      /** Optional label shown beneath the spinner (e.g. "Starting camera..."). */
      message?: string;
    }
  | {
      status: "error";
      /** The camera error message to display. */
      errorMessage?: string | null;
      onRetry: () => void;
      /** Retry button label. Defaults to "Retry". */
      retryLabel?: string;
    }
  | {
      status: "permission-denied";
      onRetry: () => void;
      /** Retry button label. Defaults to "Retry". */
      retryLabel?: string;
    };

/**
 * Shared scrim overlay for the barcode/persistent scanner status states:
 * loading, camera error, and permission-denied. Renders the correct scrim +
 * card per status. `text-white` is intentional contrast-on-scrim.
 */
export function ScannerStatusOverlay(props: ScannerStatusOverlayProps) {
  if (props.status === "loading") {
    return (
      <Row
        align="center"
        justify="center"
        className="absolute inset-0 z-10 bg-background/80"
      >
        {props.message ? (
          // text-foreground (not text-white): the loading scrim is bg-background/80,
          // which is near-white in light mode — white text would be invisible.
          <div className="flex flex-col items-center gap-2 text-foreground">
            <Spinner size="lg" />
            <span className="text-sm">{props.message}</span>
          </div>
        ) : (
          <Spinner size="lg" />
        )}
      </Row>
    );
  }

  if (props.status === "error") {
    return (
      <Row
        align="center"
        justify="center"
        className="absolute inset-0 z-10 bg-black/80 p-4"
      >
        <div className="flex flex-col items-center gap-4 rounded-lg bg-destructive/90 p-4 text-center text-white">
          <CameraSlashIcon className="size-8 opacity-80" />
          <div>
            <p className="font-medium">Camera Error</p>
            <p className="mt-1 text-sm opacity-90">{props.errorMessage}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={props.onRetry}
            className="gap-2"
          >
            <ArrowCounterClockwiseIcon className="size-3.5" />
            {props.retryLabel ?? "Retry"}
          </Button>
        </div>
      </Row>
    );
  }

  return (
    <Row
      align="center"
      justify="center"
      className="absolute inset-0 z-10 bg-black/80 p-4"
    >
      <div className="flex max-w-xs flex-col items-center gap-4 rounded-lg bg-card p-4 text-center ring-1 ring-border">
        <CameraSlashIcon className="size-10 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">Camera access needed</p>
          <Description className="mt-2">
            To scan barcodes, allow camera access in{" "}
            <span className="font-medium text-foreground">
              Settings &gt; Safari &gt; Camera
            </span>
          </Description>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={props.onRetry}
          className="gap-2"
        >
          <ArrowCounterClockwiseIcon className="size-3.5" />
          {props.retryLabel ?? "Retry"}
        </Button>
      </div>
    </Row>
  );
}
