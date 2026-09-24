import { Grid, Row } from "~/components/layout";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { entities } from "~/entities/entities";

import { Prose } from "../_components/Prose";
import { EntityRelationshipsDiagram } from "./entity-relationships-diagram";

export function ConceptsSection() {
  return (
    <>
      <Prose>
        <p>
          cubby helps you organize recipes, track ingredients, manage inventory,
          and keep everything in its place.
        </p>

        <h2>Core Concepts</h2>
        <p>cubby is built around five key entity types that work together:</p>
      </Prose>

      <Grid cols="cards3" className="my-6">
        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.ingredient.phosphorIcon className="size-5 text-muted-foreground" />
              <CardTitle>Ingredients</CardTitle>
            </Row>
            <CardDescription>
              The building blocks of recipes. Generic items like "flour" or
              "butter" that appear across multiple recipes.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.product.phosphorIcon className="size-5 text-muted-foreground" />
              <CardTitle>Products</CardTitle>
            </Row>
            <CardDescription>
              Specific purchasable items linked to ingredients. Products can
              have unit mappings, UPC barcodes, and optional USDA nutrition
              data.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.location.phosphorIcon className="size-5 text-muted-foreground" />
              <CardTitle>Locations</CardTitle>
            </Row>
            <CardDescription>
              Hierarchical storage areas (Kitchen → Pantry → Top Shelf).
              Supports types like room, shelf, drawer, and CSV import/export
              with parent references.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.recipe.phosphorIcon className="size-5 text-muted-foreground" />
              <CardTitle>Recipes</CardTitle>
            </Row>
            <CardDescription>
              Collections of ingredients with amounts, organized into sections
              with step-by-step instructions.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.inventory.phosphorIcon className="size-5 text-muted-foreground" />
              <CardTitle>Inventory</CardTitle>
            </Row>
            <CardDescription>
              Tracks what products you have and where. Links products to
              locations with quantities.
            </CardDescription>
          </CardHeader>
        </Card>
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
