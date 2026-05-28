import { createFileRoute } from "@tanstack/react-router";
import { CaptureFlow } from "~/app/capture/capture-flow";

export const Route = createFileRoute("/_authenticated/capture")({
  ssr: false,
  component: CaptureFlow,
  head: () => ({ meta: [{ title: "Scan a shelf | cubby" }] }),
});
