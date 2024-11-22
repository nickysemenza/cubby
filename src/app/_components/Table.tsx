"use client";

import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
  Checkbox,
  type ColumnProps,
  type RowProps,
  type CellProps,
  TextField,
  Input,
  Label,
  MenuTrigger,
  Button,
  Menu,
  Popover,
  MenuItem,
} from "react-aria-components";
import {
  Check,
  ArrowUp,
  ArrowDown,
  Minus,
  ArrowUpDown,
  SlidersHorizontal,
  CheckIcon,
} from "lucide-react";
import {
  type SortingState,
  flexRender,
  type Table as ITable,
} from "@tanstack/react-table";
import { ReactNode, useState } from "react";
interface TTableProps<TItem> {
  table: ITable<TItem>;
  sorting: SortingState;
}

export default function RTable<TItem>(props: TTableProps<TItem>) {
  const { table, sorting } = props;
  return (
    <div>
      <Table
        aria-label="Tasks"
        selectionMode="multiple"
        sortDescriptor={
          sorting?.length
            ? {
                column: sorting[0]?.id,
                direction: sorting[0]?.desc ? "descending" : "ascending",
              }
            : undefined
        }
        onSortChange={(sortDescriptor) => {
          table.setSorting([
            {
              id: "" + sortDescriptor.column,
              desc: sortDescriptor.direction === "descending",
            },
          ]);
        }}
        className="relative w-full caption-bottom text-sm"
      >
        <TableHeader className="sticky top-0 bg-white [&_tr]:border-b">
          {table.getFlatHeaders().map((header) => (
            <TableColumn
              key={header.id}
              id={header.id}
              isRowHeader={header.id === "id" || header.id === "title"}
              allowsSorting={header.column.getCanSort()}
            >
              {header.isPlaceholder
                ? null
                : flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
            </TableColumn>
          ))}
        </TableHeader>
        <TableBody className="[&_tr:last-child]:border-0">
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} textValue={cell.getValue() as string}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <BottomToolbar table={table} />
    </div>
  );
}

// Wrapper components so we can avoid repeating tailwind styles and DOM structure.
function TableColumn(
  props: Omit<ColumnProps, "children"> & { children: ReactNode },
) {
  return (
    <Column
      {...props}
      className="group h-12 cursor-default text-left align-middle font-medium text-gray-700 outline-none data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-black"
    >
      {({ allowsSorting, sortDirection }) => (
        <div className="inline-flex gap-2 rounded px-4 py-1 transition-colors group-[&[aria-sort]]:hover:bg-gray-100">
          {props.children}
          {allowsSorting &&
            (sortDirection === "descending" ? (
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            ) : sortDirection === "ascending" ? (
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
            ))}
        </div>
      )}
    </Column>
  );
}

function TableRow<T extends object>(props: RowProps<T>) {
  return (
    <Row
      {...props}
      className="cursor-default border-b outline-none transition-colors aria-selected:bg-gray-100 data-[hovered]:bg-gray-100/50 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-black"
    />
  );
}

function TableCell(props: CellProps) {
  return (
    <Cell
      {...props}
      className="p-4 align-middle outline-none first:pr-0 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-black"
    />
  );
}

function SelectionCheckbox() {
  return (
    <Checkbox
      slot="selection"
      className="block h-4 w-4 shrink-0 rounded border border-black ring-offset-1 data-[disabled]:cursor-not-allowed data-[indeterminate]:bg-black data-[selected]:bg-black data-[indeterminate]:text-white data-[selected]:text-white data-[disabled]:opacity-50 data-[focus-visible]:outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-black data-[focus-visible]:ring-offset-2"
    >
      {({ isSelected, isIndeterminate }) => (
        <div className="flex items-center justify-center text-current">
          {isSelected ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : isIndeterminate ? (
            <Minus className="h-4 w-4" aria-hidden="true" />
          ) : null}
        </div>
      )}
    </Checkbox>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <div className="focus:ring-ring inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2">
      {children}
    </div>
  );
}
export function BottomToolbar<TItem>({ table }: { table: ITable<TItem> }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          className="rounded border p-1"
          onClick={() => table.firstPage()}
          disabled={!table.getCanPreviousPage()}
        >
          {"<<"}
        </button>
        <button
          className="rounded border p-1"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          {"<"}
        </button>
        <button
          className="rounded border p-1"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        >
          {">"}
        </button>
        <button
          className="rounded border p-1"
          onClick={() => table.lastPage()}
          disabled={!table.getCanNextPage()}
        >
          {">>"}
        </button>
        <span className="flex items-center gap-1">
          <div>Page</div>
          <strong>
            {table.getState().pagination.pageIndex + 1} of{" "}
            {table.getPageCount().toLocaleString()}
          </strong>
        </span>
        <span className="flex items-center gap-1">
          | Go to page:
          <input
            type="number"
            min="1"
            max={table.getPageCount()}
            defaultValue={table.getState().pagination.pageIndex + 1}
            onChange={(e) => {
              const page = e.target.value ? Number(e.target.value) - 1 : 0;
              table.setPageIndex(page);
            }}
            className="w-16 rounded border p-1"
          />
        </span>
        <select
          value={table.getState().pagination.pageSize}
          onChange={(e) => {
            table.setPageSize(Number(e.target.value));
          }}
        >
          {[10, 20, 30, 40, 50].map((pageSize) => (
            <option key={pageSize} value={pageSize}>
              Show {pageSize}
            </option>
          ))}
        </select>
      </div>
      <div>
        Showing {table.getRowModel().rows.length.toLocaleString()} of{" "}
        {table.getRowCount().toLocaleString()} Rows
      </div>
      <pre>{JSON.stringify(table.getState().pagination, null, 2)}</pre>
    </div>
  );
}
export function Toolbar<TItem>({ table }: { table: ITable<TItem> }) {
  return (
    <div className="flex items-end justify-between px-4 pt-2">
      <TextField className="flex flex-col gap-1">
        <Label className="text-sm text-gray-700">Filter</Label>
        <Input
          value={(table.getColumn("name")?.getFilterValue() as string) || ""}
          onChange={(event) =>
            table.getColumn("name")?.setFilterValue(event.target.value)
          }
          className="h-8 w-[150px] rounded-md border border-gray-400 px-2 text-sm text-gray-700 outline-none focus:ring focus:ring-[2px] focus:ring-black focus:ring-offset-2 lg:w-[250px]"
        />
      </TextField>
      <MenuTrigger>
        <Button className="flex cursor-default items-center rounded-md border border-gray-300 px-2 py-1 text-sm outline-none data-[hovered]:bg-gray-100 data-[pressed]:bg-gray-200 data-[focus-visible]:ring data-[focus-visible]:ring-[2px] data-[focus-visible]:ring-black data-[focus-visible]:ring-offset-2">
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          View
        </Button>
        <Popover className="rounded-md border border-gray-300 bg-white p-2">
          <Menu
            className="outline-none"
            selectionMode="multiple"
            selectedKeys={table
              .getVisibleFlatColumns()
              .filter((c) => c.getCanHide())
              .map((c) => c.id)}
            onSelectionChange={(keys) => {
              table.setColumnVisibility(
                Object.fromEntries(
                  table
                    .getAllFlatColumns()
                    .map((c) => [
                      c.id,
                      !c.getCanHide() || keys === "all" || keys.has(c.id),
                    ]),
                ),
              );
            }}
          >
            {table
              .getAllColumns()
              .filter(
                (column) =>
                  typeof column.accessorFn !== "undefined" &&
                  column.getCanHide(),
              )
              .map((column) => {
                return (
                  <MenuItem
                    id={column.id}
                    key={column.id}
                    className="flex cursor-default items-center gap-2 rounded px-2 py-1 text-sm capitalize outline-none data-[focused]:bg-gray-100 data-[focus-visible]:ring data-[focus-visible]:ring-[2px] data-[focus-visible]:ring-black"
                  >
                    {({ isSelected }) => (
                      <>
                        {isSelected ? (
                          <CheckIcon className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <div className="h-4 w-4" />
                        )}
                        {column.id}
                      </>
                    )}
                  </MenuItem>
                );
              })}
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  );
}
