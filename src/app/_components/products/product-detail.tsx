"use client";
import { type FC, useState } from "react";
import JsonRenderer from "~/app/_components/json-renderer";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import {
  unitMappignsFromProduct,
  productWithIngredientAndInventoryAndMappingsOut,
} from "~/schemas/combo";
import { NutritionInfoTable } from "../usda/nutrition";
import { NoneState } from "../NoneState";
import { useWasm } from "~/wasmContext";
import { ProductForm } from "./product-form";
import { type ProductInputPayload } from "~/schemas/product";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";
import { useRouter } from "next/navigation";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import Link from "next/link";
import { z } from "zod";
import {
  IngredientPillLink,
  LocationPillLink,
  FoodPillLink,
} from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";
import EntityImageList from "../EntityImageList";

import { useMutation } from "@tanstack/react-query";

interface ProductDetailProps {
  product: z.infer<typeof productWithIngredientAndInventoryAndMappingsOut>;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const api = useTRPC();
  const { w } = useWasm();
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const updateProduct = useMutation(
    api.product.update.mutationOptions({
      onSuccess: () => {
        setIsEditing(false);
        router.refresh();
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleEdit = (data: {
    id: string;
    data: Partial<ProductInputPayload>;
  }) => {
    updateProduct.mutate(data);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setError(undefined);
  };

  // Get product images from the product object
  const productImages = product.images || [];

  const mappings = unitMappignsFromProduct(product);
  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: isEditing ? (
        <div className="container mx-auto py-10">
          <h1 className="mb-6 text-2xl font-bold">Edit Product</h1>
          <ProductForm
            mode="edit"
            entity={product}
            onEdit={handleEdit}
            isPending={updateProduct.isPending}
            error={error}
            onCancel={handleCancel}
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
                className="text-blue-600 hover:underline"
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
                className="text-blue-600 hover:underline"
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
            <Button onClick={() => setIsEditing(true)}>Edit</Button>
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
      content: w && <UnitMappingDisplay mappings={mappings} w={w} title="" />,
    },
    {
      title: "Raw Details",
      content: (
        <div className="bg-muted rounded-md p-4">
          <JsonRenderer input={product} />
        </div>
      ),
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
    <DetailPage sections={sections} entity="product" name={product.name} />
  );
};
