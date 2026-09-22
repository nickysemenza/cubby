import { createFileRoute } from "@tanstack/react-router";

import { LegalPage } from "~/app/legal/legal-page";
import { pageTitle } from "~/lib/page-title";

// Public by design: Google's OAuth consent screen requires an unauthenticated
// terms-of-service URL on an authorized domain.
export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: pageTitle("Terms") }] }),
  component: TermsRoute,
});

function TermsRoute() {
  return (
    <LegalPage title="Terms of service" updated="September 2026">
      <p>
        Cubby is a private, non-commercial app operated by one household for its
        own members. Access is by invitation of the operator, who may end it at
        any time.
      </p>
      <p>
        <strong>Use it for its purpose.</strong> Record and read your
        household&rsquo;s own belongings, purchases and meals. Do not attempt to
        access another household&rsquo;s data or disrupt the service.
      </p>
      <p>
        <strong>No warranty.</strong> The app is provided as is, with no
        warranty and no guarantee of availability or of the accuracy of any
        record. It is not a system of record for anything that matters legally
        or financially, and the operator is not liable for loss arising from its
        use.
      </p>
      <p>
        Your data is handled as described in the{" "}
        <a href="/privacy">privacy policy</a>.
      </p>
    </LegalPage>
  );
}
