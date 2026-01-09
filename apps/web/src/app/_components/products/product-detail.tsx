import { Activity, Apple, Info } from "lucide-react";
import type { FC } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import type { ProductInputPayload } from "~/schemas/product";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { NutritionInfoTable } from "../usda/nutrition";
import { ProductActivitiesTab } from "./product-activities-tab";
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
    // Custom section: Activities
    {
      title: "Activities",
      icon: Activity,
      content: <ProductActivitiesTab productId={product.id} />,
    },
    // Custom section: Nutrition (only if available)
    ...(product.food?.nutritionInfo
      ? [
          {
            title: "Nutrition Information",
            icon: Apple,
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
