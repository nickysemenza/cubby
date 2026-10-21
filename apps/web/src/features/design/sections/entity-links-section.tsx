import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { Stack } from "~/ui/layout";

import { Demo, DemoGrid } from "../components/design-section";

const PRODUCT = { id: "PRD-2222", name: "Sample oat milk" };

export function EntityLinksSection() {
  return (
    <DemoGrid>
      <Demo
        name="<EntityRefLink />"
        note="Inline record identity, with a leading mark and hover preview."
      >
        <EntityRefLink entity="product" data={PRODUCT} displayImage={null} />
      </Demo>
      <Demo
        name={'<EntityRefLink variant="chip" />'}
        note="Record links with normal and compact presentations. Compact references share EnumPill geometry."
      >
        <Stack gap="sm">
          <EntityRefLink
            variant="chip"
            entity="spendingCategory"
            id="SPC-2222"
            name="Sample groceries"
            emoji="🛒"
            displayImage={null}
          />
          <EntityRefLink
            variant="chip"
            compact
            entity="spendingCategory"
            id="SPC-2222"
            name="Sample groceries"
            emoji="🛒"
            displayImage={null}
          />
        </Stack>
      </Demo>
      <Demo
        name={'<EntityRefLink variant="table" tone="identity" />'}
        note="The row's own name beside its image column, or a code (mono). A reference to another record uses chip. All examples link to synthetic records."
      >
        <EntityRefLink
          variant="table"
          tone="identity"
          to="/products/$shortcode"
          params={{ shortcode: PRODUCT.id }}
        >
          {PRODUCT.name}
        </EntityRefLink>
      </Demo>
    </DemoGrid>
  );
}
