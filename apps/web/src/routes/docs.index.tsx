import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_DOC_SLUG } from "~/app/docs/docs-registry";

export const Route = createFileRoute("/docs/")({
  beforeLoad: () => {
    throw redirect({
      to: "/docs/$section",
      params: { section: DEFAULT_DOC_SLUG },
    });
  },
});
