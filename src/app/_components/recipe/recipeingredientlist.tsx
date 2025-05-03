"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Result, withFailure, type Flatten } from "~/misc/util";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { SectionIngredientOut } from "~/schemas/recipe";
import JsonRenderer from "../json-renderer";
import RTable from "../data-table/Table";
import { IngredientOut, unitMappignsFromProduct } from "~/schemas/combo";
import { useMemo } from "react";
import { useWasm, wasm } from "~/wasmContext";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { WMeasure } from "recipebridge/pkg/recipebridge";
import { NutrientsPer100 } from "~/schemas/usda";
import { renderValueOrError } from "~/misc/result";
import {
  convertAmountToPrice,
  getGramAndNutrient,
} from "~/app/_components/units/univ-conversion";

dayjs.extend(relativeTime);

const getPrice = (
  w: wasm,
  ingredient: SectionIngredientOut,
  ingMap: Record<string, IngredientOut>,
): {
  price: Result<WMeasure>;
  gram: Result<WMeasure>;
  nutrient: Result<NutrientsPer100>;
} => {
  const id = ingredient.ingredient?.id;
  const entry = id ? ingMap[id] : undefined;
  const product = entry?.product;
  const mappings = product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
  const firstAmount = ingredient.amounts[0];
  // todo: should additional amounts be added to the mappings?

  if (!firstAmount) {
    const error = `ingredient ${ingredient.id} has no amounts`;
    return {
      price: withFailure(error),
      gram: withFailure(error),
      nutrient: withFailure(error),
    };
  }

  const price = convertAmountToPrice(w, firstAmount, mappings);
  const { gram, nutrient } = getGramAndNutrient(
    w,
    firstAmount,
    mappings,
    product,
  );

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
