import { BowlFoodIcon as Apple } from "@phosphor-icons/react/dist/csr/BowlFood";
import { ScalesIcon as Scale } from "@phosphor-icons/react/dist/csr/Scales";
import { WarningIcon as AlertTriangle } from "@phosphor-icons/react/dist/csr/Warning";

import { Grid, Row } from "~/components/layout";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { entities } from "~/entities/entities";

import { Prose } from "../_components/Prose";

export function FeaturesSection() {
  return (
    <>
      <Prose>
        <h2>Features</h2>
      </Prose>

      <Grid cols="cards3" className="my-6">
        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.recipe.phosphorIcon className="size-5 text-muted-foreground" />
              <CardTitle>Recipes</CardTitle>
            </Row>
            <CardDescription>
              Create recipes with multiple sections, import from URLs, and nest
              recipes within other recipes as sub-components.
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
              Link to ingredients, add unit mappings, connect to USDA for
              nutrition. Use <code className="text-xs">misc:</code> prefix for
              items not worth tracking individually.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <entities.inventory.phosphorIcon className="size-5 text-muted-foreground" />
              <CardTitle>Inventory Management</CardTitle>
            </Row>
            <CardDescription>
              Track quantities at locations, bulk edit/move items, and
              automatically detect duplicate unique products.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <Apple className="size-5 text-muted-foreground" />
              <CardTitle>USDA Integration</CardTitle>
            </Row>
            <CardDescription>
              Search FoodData Central by name, UPC, or NDB number. View detailed
              nutrition and link products to USDA entries.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <Scale className="size-5 text-muted-foreground" />
              <CardTitle>Unit Conversions</CardTitle>
            </Row>
            <CardDescription>
              WASM-powered engine that chains conversions through multiple units
              (cups → grams → dollars) using product mappings.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <AlertTriangle className="size-5 text-muted-foreground" />
              <CardTitle>Problems Dashboard</CardTitle>
            </Row>
            <CardDescription>
              Find duplicate products, missing inventory, invalid UPCs, products
              without unit mappings, and empty locations.
            </CardDescription>
          </CardHeader>
        </Card>
      </Grid>
    </>
  );
}
