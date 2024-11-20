import { type Table as RTAble, flexRender } from "@tanstack/react-table";

interface TableProps<TItem> {
  table: RTAble<TItem>;
}

export default function Table<TItem>(props: TableProps<TItem>) {
  const table = props.table;
  return (
    <table className="borderw-full text-left text-sm text-gray-500 dark:text-gray-400">
      <thead className="bg-gray-50 text-xs uppercase text-gray-700 dark:bg-gray-700 dark:text-gray-400">
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id} className="px-6 py-3">
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr
            key={row.id}
            className="border-b bg-white dark:border-gray-700 dark:bg-gray-800"
          >
            {row.getVisibleCells().map((cell) => (
              <td className="px-6 py-3" key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
