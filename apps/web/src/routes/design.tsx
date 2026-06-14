import { createFileRoute } from "@tanstack/react-router";
import { DesignGallery } from "~/app/_components/design/design-gallery";

export const Route = createFileRoute("/design")({
  component: DesignGallery,
});
