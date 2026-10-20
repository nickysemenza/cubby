import { Grid, Section } from "~/ui/layout";

import { Prose } from "../components/prose";

export function FeaturesSection() {
  return (
    <>
      <Prose>
        <h2>Features</h2>
      </Prose>

      <Grid cols="cards3" className="my-6">
        <Section headingAs="h3" compact title="Recipes">
          <p className="text-muted-foreground">
            Create recipes with multiple sections, import from URLs, and nest
            recipes within other recipes as sub-components.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Products">
          <p className="text-muted-foreground">
            Link to ingredients, add unit mappings, connect to USDA for
            nutrition. Use <code className="text-xs">misc:</code> prefix for
            items not worth tracking individually.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Inventory management">
          <p className="text-muted-foreground">
            Track quantities at locations, bulk edit/move items, and
            automatically detect duplicate unique products.
          </p>
        </Section>

        <Section headingAs="h3" compact title="USDA integration">
          <p className="text-muted-foreground">
            Search FoodData Central by name, UPC, or NDB number. View detailed
            nutrition and link products to USDA entries.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Unit conversions">
          <p className="text-muted-foreground">
            WASM-powered engine that chains conversions through multiple units
            (cups → grams → dollars) using product mappings.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Problems dashboard">
          <p className="text-muted-foreground">
            Find duplicate products, missing inventory, invalid UPCs, products
            without unit mappings, and empty locations.
          </p>
        </Section>
      </Grid>
    </>
  );
}
