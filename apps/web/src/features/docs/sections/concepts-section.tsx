import { Grid, Section } from "~/ui/layout";

import { Prose } from "../components/prose";
import { EntityRelationshipsDiagram } from "./entity-relationships-diagram";

export function ConceptsSection() {
  return (
    <>
      <Prose>
        <p>
          cubby helps you organize recipes, track ingredients, manage inventory,
          and keep everything in its place.
        </p>

        <h2>Core concepts</h2>
        <p>cubby is built around five key entity types that work together:</p>
      </Prose>

      <Grid cols="cards3" className="my-6">
        <Section headingAs="h3" compact title="Ingredients">
          <p className="text-muted-foreground">
            The building blocks of recipes. Generic items like "flour" or
            "butter" that appear across multiple recipes.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Products">
          <p className="text-muted-foreground">
            Specific purchasable items linked to ingredients. Products can have
            unit mappings, UPC barcodes, and optional USDA nutrition data.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Locations">
          <p className="text-muted-foreground">
            Hierarchical storage areas (Kitchen → Pantry → Top Shelf). Supports
            types like room, shelf, drawer, and CSV import/export with parent
            references.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Recipes">
          <p className="text-muted-foreground">
            Collections of ingredients with amounts, organized into sections
            with step-by-step instructions.
          </p>
        </Section>

        <Section headingAs="h3" compact title="Inventory">
          <p className="text-muted-foreground">
            Tracks what products you have and where. Links products to locations
            with quantities.
          </p>
        </Section>
      </Grid>

      <div className="my-6">
        <div className="mb-2 font-medium">Entity Relationships</div>
        <div className="overflow-hidden border border-[var(--border)] bg-card p-4">
          <EntityRelationshipsDiagram />
        </div>
      </div>
    </>
  );
}
