import type { FC } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import type { ProductInputPayload } from "~/schemas/product";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { NutritionInfoTable } from "../usda/nutrition";
import { ProductBasicInfo } from "./product-basic-info";
import { ProductForm } from "./product-form";

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
          <h1 className="mb-6 font-bold text-2xl">Edit Product</h1>
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
              <MutedBox>
                <NutritionInfoTable n={product.food.nutritionInfo} limit={10} />
              </MutedBox>
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
