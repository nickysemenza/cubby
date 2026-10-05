import { createFileRoute } from "@tanstack/react-router";

import { UsdaAlternateIdRedirect } from "~/app/usda/usda-alternate-id-redirect";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/usda/ndb/$code")({
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`USDA NDB ${params.code}`) }],
  }),
  component: USDANDBLookupPage,
});

function USDANDBLookupPage() {
  const { code } = Route.useParams();
  return (
    <UsdaAlternateIdRedirect
      alternateId={{ kind: "ndb", ndb_number: parseInt(code, 10) }}
      label={`NDB ${code}`}
      notFoundDescription="No USDA food record matched this legacy NDB number."
    />
  );
}
