"use client";

import { type FC } from "react";
import JsonRenderer from "~/app/_components/json-renderer";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import {
  unitMappignsFromProduct,
  type ProductWithMappingsAndFoodOut,
} from "~/schemas/combo";
import { NutritionInfoTable } from "../usda/nutrition";
import { NoneState } from "../NoneState";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { useWasm } from "~/wasmContext";

interface ProductDetailProps {
  product: ProductWithMappingsAndFoodOut;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const { w } = useWasm();
  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: (
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
            {product.upc ? product.upc : <NoneState />}
          </div>
          <div>
            <span className="font-medium">NDB Number:</span>{" "}
            {product.ndb_number ? product.ndb_number : <NoneState />}
          </div>
        </div>
      ),
    },
    {
      title: "Unit Mappings",
      content: (
        <div className="space-y-2">
          {w && (
            <UnitMappingsTable
              mappings={unitMappignsFromProduct(product)}
              w={w}
            />
          )}
        </div>
      ),
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
    sections.splice(1, 0, {
      title: "Nutrition Information",
      content: (
        <div className="bg-muted rounded-md p-4">
          <NutritionInfoTable n={product.food.nutritionInfo} limit={10} />
        </div>
      ),
    });
  }

  return <DetailPage sections={sections} title="product" />;
};
