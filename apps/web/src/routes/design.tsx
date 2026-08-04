import { createFileRoute } from "@tanstack/react-router";
import { DesignGallery } from "~/app/_components/design/design-gallery";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/design")({
  head: () => ({ meta: [{ title: pageTitle("Design") }] }),
  component: DesignGallery,
});
