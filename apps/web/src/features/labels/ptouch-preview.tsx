import { getShortcodeUrl } from "@cubby/shared";

import { Description } from "~/ui/primitives/description";
import { StaticTable } from "~/ui/primitives/static-table";

import type { LabelItem } from "./sheet-layouts";

export function PtouchPreview({ items }: { items: LabelItem[] }) {
  return (
    <StaticTable
      className="table-auto"
      rows={items}
      rowKey={(item) => item.shortcode}
      columns={[
        {
          id: "column-0",
          header: "Shortcode",
          cellClassName: "font-mono",
          cell: (item) => item.shortcode,
        },
        {
          id: "column-1",
          header: "Name",
          cellClassName: "whitespace-normal",
          cell: (item) => (
            <>
              {item.name}
              {item.parentName && (
                <Description as="span" size="xs" className="ml-2">
                  {item.parentName}
                </Description>
              )}
            </>
          ),
        },
        {
          id: "column-2",
          header: "URL",
          cellClassName: "text-muted-foreground",
          cell: (item) => getShortcodeUrl(item.shortcode),
        },
      ]}
    />
  );
}
