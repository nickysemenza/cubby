import type { ProductCreateInput } from "@cubby/schemas/product";
import { Apple, Info } from "lucide-react";
import type { FC } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
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
    { id: string; data: Partial<ProductCreateInput> }
  >({
    entity: "product",
    data: product,
    mutationOptions: api.product.update.mutationOptions(),
    getMappings: getAllUnitMappingsFromProduct,
  });

  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      icon: Info,
      content: editMode.isEditing ? (
        <ProductForm
          mode="edit"
          entity={product}
          onEdit={editMode.handleEdit}
          isPending={editMode.isPending}
          error={editMode.error}
          onCancel={editMode.handleCancel}
        />
      ) : (
        <ProductBasicInfo product={product} onEdit={editMode.startEditing} />
      ),
    },
    // Custom section: Nutrition (only if available)
    ...(product.food?.nutritionInfo
      ? [
          {
            title: "Nutrition Information",
            icon: Apple,
            content: (
              <MutedBox>
                <NutritionInfoTable n={product.food.nutritionInfo} />
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
