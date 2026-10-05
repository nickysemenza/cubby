import { createFileRoute } from "@tanstack/react-router";

import { UsdaAlternateIdRedirect } from "~/app/usda/usda-alternate-id-redirect";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/usda/upc/$code")({
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`USDA UPC ${params.code}`) }],
  }),
  component: USDAUPCLookupPage,
});

function USDAUPCLookupPage() {
  const { code } = Route.useParams();
  return (
    <UsdaAlternateIdRedirect
      alternateId={{ kind: "upc", gtin_upc: code }}
      label={`UPC ${code}`}
      notFoundDescription="No USDA food is linked to that barcode yet."
    />
  );
}
