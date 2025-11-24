"use client";
import { type FC } from "react";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { useWasm } from "~/hooks/useWasm";
import { type ProductWithFoodOut } from "~/server/services/product.service";
import { NutritionInfoTable } from "../usda/nutrition";
import { NoneState } from "../NoneState";
import { ProductForm } from "./product-form";
import { type ProductInputPayload } from "~/schemas/product";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import Link from "next/link";
import {
  IngredientPillLink,
  LocationPillLink,
  FoodPillLink,
} from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";
import EntityImageList from "../EntityImageList";
import { useEditMode } from "../hooks/useEditMode";

interface ProductDetailProps {
  product: ProductWithFoodOut;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const api = useTRPC();
  const w = useWasm();

  const editMode = useEditMode<{
    id: string;
    data: Partial<ProductInputPayload>;
  }>({
    mutationOptions: api.product.update.mutationOptions(),
    useRouterRefresh: true,
  });

  // Get product images from the product object
  const productImages = product.images || [];

  const mappings = getAllUnitMappingsFromProduct(product, w);
  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: editMode.isEditing ? (
        <div className="container mx-auto py-10">
          <h1 className="mb-6 text-2xl font-bold">Edit Product</h1>
          <ProductForm
            mode="edit"
            entity={product}
            onEdit={editMode.handleEdit}
            isPending={editMode.isPending}
            error={editMode.error}
            onCancel={editMode.handleCancel}
          />
        </div>
      ) : (
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
            <span className="font-medium">UPC:</span>{" "}
            {product.upc ? (
              <Link
                href={`/usda/upc/${product.upc}`}
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
                href={`/usda/ndb/${product.ndb_number}`}
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
                <IngredientPillLink
                  name={product.ingredient.name}
                  id={product.ingredient.id}
                />
              </div>
            )}
            {product.food && (
              <div>
                <span className="font-medium">USDA Food:</span>{" "}
                <FoodPillLink food={product.food} />
              </div>
            )}
            {product.inventoryEntry && product.inventoryEntry.length > 0 && (
              <div>
                <span className="font-medium">Inventory Locations:</span>{" "}
                <div className="mt-1 flex flex-wrap gap-1">
                  <EntityPillLinkList
                    items={product.inventoryEntry.map((entry) => ({
                      id: entry.location.id,
                      name: entry.location.name,
                      type: entry.location.type,
                    }))}
                    Pill={LocationPillLink}
                    pillPropName="location"
                  />
                </div>
              </div>
            )}
          </div>
          <div className="mt-4">
            <Button onClick={editMode.startEditing}>Edit</Button>
          </div>
        </div>
      ),
    },
    {
      title: "Images",
      content: <EntityImageList images={productImages} />,
    },
    {
      title: "Unit Mappings",
      content: <UnitMappingDisplay mappings={mappings} title="" />,
    },
  ];

  // Add nutrition section if available
  if (product.food?.nutritionInfo) {
    sections.splice(2, 0, {
      title: "Nutrition Information",
      content: (
        <div className="bg-muted rounded-md p-4">
          <NutritionInfoTable n={product.food.nutritionInfo} limit={10} />
        </div>
      ),
    });
  }

  return (
    <DetailPage
      sections={sections}
      entity="product"
      name={product.name}
      rawData={product}
    />
  );
};
