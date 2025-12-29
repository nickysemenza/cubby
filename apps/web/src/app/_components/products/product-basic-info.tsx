import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { InfoRow } from "~/components/common/info-row";
import { Button } from "~/components/ui/button";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { EntityPillLink } from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";

interface ProductBasicInfoProps {
  product: ProductWithFoodOut;
  onEdit: () => void;
}

export const ProductBasicInfo: FC<ProductBasicInfoProps> = ({
  product,
  onEdit,
}) => {
  return (
    <div className="space-y-2">
      <InfoRow label="Name">{product.name}</InfoRow>
      <InfoRow label="Manufacturer">{product.manufacturer}</InfoRow>
      <InfoRow label="Model">{product.model}</InfoRow>
      <InfoRow label="Category">
        {product.category ? (
          <span className="capitalize">
            {product.category.replace("-", " ")}
          </span>
        ) : undefined}
      </InfoRow>
      <InfoRow label="UPC">
        {product.upc ? (
          <Link
            to="/usda/upc/$code"
            params={{ code: product.upc }}
            className="text-primary hover:underline"
          >
            {product.upc}
          </Link>
        ) : undefined}
      </InfoRow>
      <InfoRow label="NDB Number">
        {product.ndb_number ? (
          <Link
            to="/usda/ndb/$code"
            params={{ code: String(product.ndb_number) }}
            className="text-primary hover:underline"
          >
            {product.ndb_number}
          </Link>
        ) : undefined}
      </InfoRow>
      <div className="mt-4 space-y-2">
        {product.ingredient && (
          <InfoRow label="Ingredient">
            <EntityPillLink
              entity="ingredient"
              data={{
                name: product.ingredient.name,
                id: product.ingredient.id,
              }}
            />
          </InfoRow>
        )}
        {product.food && (
          <InfoRow label="USDA Food">
            <EntityPillLink entity="usda-food" data={product.food} />
          </InfoRow>
        )}
        {product.inventoryEntry && product.inventoryEntry.length > 0 && (
          <InfoRow label="Inventory Locations">
            <div className="mt-1 flex flex-wrap gap-1">
              <EntityPillLinkList
                entity="location"
                items={product.inventoryEntry.map((entry) => ({
                  id: entry.location.id,
                  name: entry.location.name,
                  type: entry.location.type,
                }))}
              />
            </div>
          </InfoRow>
        )}
      </div>
      <div className="mt-4">
        <Button onClick={onEdit}>Edit</Button>
      </div>
    </div>
  );
};
