"use client";

import { api } from "~/trpc/react";
import JsonRenderer from "./json";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type Flatten } from "~/util";
import Table from "./Table";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import Link from "next/link";

dayjs.extend(relativeTime);

export function RecipeList() {
  const [recipes] = api.recipe.list.useSuspenseQuery();

  const columnHelper = createColumnHelper<Flatten<typeof recipes>>();

  const columns = [
    columnHelper.accessor("name", {
      cell: (info) => info.getValue(),
    }),
    columnHelper.display({
      id: "sections",
      cell: (info) => {
        return info.row.original.sections.map((section) => (
          <li key={section.id}>
            {section.name}
            <ul className="ml-4 list-inside list-disc">
              {section.ingredients.map((ingredient) => (
                <li key={ingredient.id}>
                  <div>
                    {ingredient.ingredient?.name}
                    <JsonRenderer input={ingredient.amounts} />
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ));
      },
    }),

    columnHelper.accessor("createdAt", {
      cell: (info) => dayjs(info.getValue()).fromNow(),
    }),
    columnHelper.accessor("id", {
      cell: (info) => (
        <div>
          <Link
            className="group-selected:bg-slate-700 group-selected:border-slate-800 rounded border border-slate-200 bg-slate-100 px-1 font-mono font-medium text-blue-600 hover:underline dark:text-blue-500"
            href={`recipes/${info.getValue()}`}
          >
            {info.getValue()}
          </Link>
        </div>
      ),
    }),
  ];
  const table = useReactTable({
    data: recipes,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div>
      <Table table={table} />
    </div>
  );
}
