import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { Button } from "~/components/ui/button";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { EntityPillLink } from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { NoneState } from "../NoneState";

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
      <div>
        <span className="font-medium">Name:</span> {product.name}
      </div>
      <div>
        <span className="font-medium">Manufacturer:</span>{" "}
        {product.manufacturer}
      </div>
      <div>
        <span className="font-medium">Model:</span>{" "}
        {product.model ? product.model : <NoneState />}
      </div>
      <div>
        <span className="font-medium">Category:</span>{" "}
        {product.category ? (
          <span className="capitalize">
            {product.category.replace("-", " ")}
          </span>
        ) : (
          <NoneState />
        )}
      </div>
      <div>
        <span className="font-medium">UPC:</span>{" "}
        {product.upc ? (
          <Link
            to="/usda/upc/$code"
            params={{ code: product.upc }}
            className="text-primary hover:underline"
          >
            {product.upc}
          </Link>
        ) : (
          <NoneState />
        )}
      </div>
      <div>
        <span className="font-medium">NDB Number:</span>{" "}
        {product.ndb_number ? (
          <Link
            to="/usda/ndb/$code"
            params={{ code: String(product.ndb_number) }}
            className="text-primary hover:underline"
          >
            {product.ndb_number}
          </Link>
        ) : (
          <NoneState />
        )}
      </div>
      <div className="mt-4 space-y-2">
        {product.ingredient && (
          <div>
            <span className="font-medium">Ingredient:</span>{" "}
            <EntityPillLink
              entity="ingredient"
              data={{
                name: product.ingredient.name,
                id: product.ingredient.id,
              }}
            />
          </div>
        )}
        {product.food && (
          <div>
            <span className="font-medium">USDA Food:</span>{" "}
            <EntityPillLink entity="usda-food" data={product.food} />
          </div>
        )}
        {product.inventoryEntry && product.inventoryEntry.length > 0 && (
          <div>
            <span className="font-medium">Inventory Locations:</span>{" "}
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
          </div>
        )}
      </div>
      <div className="mt-4">
        <Button onClick={onEdit}>Edit</Button>
      </div>
    </div>
  );
};
