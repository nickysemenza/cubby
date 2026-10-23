import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { Stack } from "~/ui/layout";

import { Demo, DemoGrid } from "../components/design-section";
import { demoProducts } from "../data/samples";

export function EntityLinksSection() {
  return (
    <DemoGrid>
      <Demo
        name="<EntityRefLink />"
        note="22px neutral pill, 12px label, image first. All examples use synthetic records."
      >
        <Stack gap="sm">
          <EntityRefLink
            entity="product"
            id="PRD-2222"
            name="Sample oat milk"
            displayImage={demoProducts[0]?.images[0] ?? null}
            emoji={null}
          />
          <EntityRefLink
            entity="purchase"
            id="PUR-2222"
            name="Autumn wardrobe"
            displayImage={demoProducts[1]?.images[0] ?? null}
            emoji={null}
          />
        </Stack>
      </Demo>
      <Demo
        name="Canonical fallback marks"
        note="The same record mark everywhere, including LedgerParty initials. Images replace marks when available."
      >
        <Stack gap="sm">
          <EntityRefLink
            entity="spendingCategory"
            id="SPC-2222"
            name="Sample groceries"
            emoji="🛒"
          />
          <EntityRefLink
            entity="ledgerParty"
            id="PTY-2222"
            name="Alex Rivera"
            emoji={null}
          />
          <EntityRefLink
            entity="vendor"
            id="VEN-2222"
            name="Example Apparel"
            emoji={null}
          />
        </Stack>
      </Demo>
      <Demo
        name="<EntityRefLink bare />"
        note="Only the linked name. Primary table names use this beside the dedicated image column; navigation and hover preview are shared."
      >
        <EntityRefLink
          entity="product"
          id="PRD-2222"
          name="Sample oat milk"
          displayImage={demoProducts[0]?.images[0] ?? null}
          bare
        />
      </Demo>
    </DemoGrid>
  );
}
