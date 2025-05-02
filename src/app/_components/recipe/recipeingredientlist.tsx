"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Result, withFailure, withSuccess, type Flatten } from "~/misc/util";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { SectionIngredientOut } from "~/schemas/recipe";
import JsonRenderer from "../json-renderer";
import RTable from "../data-table/Table";
import {
  IngredientOut,
  test123,
  unitMappignsFromProduct,
} from "~/schemas/combo";
import { useMemo } from "react";
import { useWasm, wasm } from "~/wasmContext";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { WMeasure } from "recipebridge/pkg/recipebridge";
import { NutrientsPer100 } from "~/schemas/usda";
import { renderValueOrError } from "~/misc/result";

dayjs.extend(relativeTime);

// getPrice extracts the price, grams, and nutrients from the ingredient
const getPrice = (
  w: wasm,
  ingredient: SectionIngredientOut,
  ingMap: Record<string, IngredientOut>,
) => {
  let price: Result<WMeasure>;
  let gram: Result<WMeasure>;
  let nutrient: Result<NutrientsPer100>;

  const id = ingredient.ingredient?.id;
  const entry = id ? ingMap[id] : undefined;
  const product = entry?.product;
  const mappings = product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
  const nutrientA = product
    ?.flatMap((p) => test123(p))
    .filter((x) => x !== undefined);
  const firstAmount = ingredient.amounts[0];
  if (firstAmount) {
    try {
      price = withSuccess(
        w.convert_to_dollars_via_mappings(mappings, "money", firstAmount),
      );
    } catch (e) {
      price = withFailure("convert to money: " + e);
    }
    try {
      const gramsValue = w.convert_to_dollars_via_mappings(
        mappings,
        "weight",
        firstAmount,
      );
      gram = withSuccess(gramsValue);
      const firstNutrietn = nutrientA?.pop();
      if (firstNutrietn) {
        nutrient = withSuccess({
          protein: (gramsValue.value / 100) * (firstNutrietn.protein || 0),
          kcal: (gramsValue.value / 100) * (firstNutrietn.kcal || 0),
        });
      } else {
        nutrient = withFailure(`product(s) have no nutrients`);
      }
    } catch (e) {
      gram = withFailure("convert to weight: " + e);
      nutrient = withFailure("convert to weight: " + e);
    }
  } else {
    price = withFailure(`ingredient ${ingredient.id} has no amounts`);
    gram = withFailure(`ingredient ${ingredient.id} has no amounts`);
    nutrient = withFailure(`ingredient ${ingredient.id} has no amounts`);
  }

  return { price, gram, nutrient };
};
const sumPrice = (
  w: wasm,
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientOut>,
) => {
  const prices: WMeasure[] = [];
  const grams: WMeasure[] = [];
  const missing = [];
  const nutrients: NutrientsPer100[] = [];
  for (const ingredient of ingredients) {
    const ingName = ingredient.ingredient?.name;
    try {
      const { price, gram, nutrient } = getPrice(w, ingredient, ingMap);

      if (price.success) {
        prices.push(price.value);
      } else {
        missing.push(`price-${ingName}`);
      }
      if (gram.success) {
        grams.push(gram.value);
      } else {
        missing.push(`gram-${ingName}`);
      }
      if (nutrient.success) {
        nutrients.push(nutrient.value);
      } else {
        missing.push(`nutrient-${ingName}`);
      }
      continue;
    } catch (e) {
      console.log(`Error in getPrice for ${ingName}`, e);
      missing.push(ingName);
    }
  }
  return {
    price: prices.reduce((acc, curr) => acc + (curr.value || 0), 0),
    protein: nutrients.reduce((acc, curr) => acc + curr.protein, 0),
    kcal: nutrients.reduce((acc, curr) => acc + curr.kcal, 0),
    weight: grams.reduce((acc, curr) => acc + curr.value, 0),
    missing,
  };
  // return prices;
};
export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  const { w } = useWasm();
  const data = useMemo(() => {
    return w
      ? ingredients.map((i) => ({
          ...i,
          priceInfo: ingMap && getPrice(w, i, ingMap),
        }))
      : [];
  }, [ingredients, ingMap, w]);
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    columnHelper.accessor(
      (ingredient) => ingredient.ingredient?.name || "Unknown",
      {
        id: "ing name",
        cell: (info) => info.getValue(),
      },
    ),
    columnHelper.accessor("amounts", {
      cell: (info) => {
        return <JsonRenderer input={info.getValue()} />;
      },
    }),
    columnHelper.display({
      id: "dollars",
      header: "dollars",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.price;
        return (
          w &&
          measure &&
          renderValueOrError(measure, (m) => w.format_measure(m))
        );
      },
    }),
    columnHelper.display({
      id: "grams",
      header: "grams",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.gram;
        return (
          w &&
          measure &&
          renderValueOrError(measure, (m) => w.format_measure(m))
        );
      },
    }),
    columnHelper.display({
      id: "nutrient",
      header: "nutrient",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.nutrient;
        return (
          measure &&
          renderValueOrError(measure, (m) => <JsonRenderer input={m} />)
        );
      },
    }),
    // columnHelper.accessor("priceInfo", {
    //   cell: (info) => {
    //     return <JsonRenderer input={info.getValue()} />;
    //   },
    // }),
    columnHelper.accessor("ingredient", {
      cell: (info) => {
        return <JsonRenderer input={info.getValue()} />;
      },
    }),

    columnHelper.display({
      id: "actions",
      cell: (props) => {
        if (ingMap === undefined || w === undefined) {
          return "loading";
        }
        const id = props.row.original.ingredient?.id;
        const entry = id ? ingMap[id] : undefined;
        const mappings =
          entry?.product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
        return <div>{buildunitMappingsGraph(w, mappings)}</div>;
      },
    }),

    columnHelper.accessor("createdAt", {
      cell: (info) => dayjs(info.getValue()).fromNow(),
    }),
  ];
  const table = useReactTable({
    data: data,
    columns,
    enableSorting: false,
    enableFilters: false,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    // manualSorting: true,
    // manualFiltering: true,
    // manualPagination: true,
    rowCount: ingredients.length,
    state: {
      pagination: {
        pageSize: ingredients.length,
        pageIndex: 0,
      },
    },
  });

  const totalPrice = useMemo(() => {
    return w && ingMap && sumPrice(w, ingredients, ingMap);
  }, [ingMap, ingredients, w]);
  return (
    <div>
      <JsonRenderer input={totalPrice} />
      <RTable table={table} />
    </div>
  );
};
