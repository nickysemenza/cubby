import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  legacyToolSearchToTools,
  toolMatrixSearchSchema,
} from "~/app/tools/tool-search";

export const Route = createFileRoute("/_authenticated/projects/tools")({
  validateSearch: toolMatrixSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/tools",
      search: legacyToolSearchToTools(search),
      replace: true,
    });
  },
});
