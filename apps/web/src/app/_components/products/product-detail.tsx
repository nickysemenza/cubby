"use client";

import { type FC } from "react";
import { type DetailSection, DetailPage } from "../data-table/detail-page";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { type ProductWithFoodOut } from "~/server/services/product.service";
import { NutritionInfoTable } from "../usda/nutrition";
import { ProductForm } from "./product-form";
import { type ProductInputPayload } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { ProductBasicInfo } from "./product-basic-info";

interface ProductDetailProps {
  product: ProductWithFoodOut;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const api = useTRPC();

  const { commonSections, editMode } = useEntityDetail<
    ProductWithFoodOut,
    { id: string; data: Partial<ProductInputPayload> }
  >({
    entity: "product",
    data: product,
    mutationOptions: api.product.update.mutationOptions(),
    getMappings: getAllUnitMappingsFromProduct,
  });

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
        <ProductBasicInfo product={product} onEdit={editMode.startEditing} />
      ),
    },
    // Custom section: Nutrition (only if available)
    ...(product.food?.nutritionInfo
      ? [
          {
            title: "Nutrition Information",
            content: (
              <div className="bg-muted rounded-md p-4">
                <NutritionInfoTable n={product.food.nutritionInfo} limit={10} />
              </div>
            ),
          },
        ]
      : []),
    // Common sections from entity config (Images, Unit Mappings, History)
    ...commonSections,
  ];

  return (
    <DetailPage
      sections={sections}
      entity="product"
      name={product.name}
      rawData={product}
    />
  );
};
