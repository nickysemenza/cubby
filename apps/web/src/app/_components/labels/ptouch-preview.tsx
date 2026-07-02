import { getShortcodeUrl } from "@cubby/shared";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import type { LabelItem } from "./sheet-layouts";

export function PtouchPreview({ items }: { items: LabelItem[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table className="table-auto">
          <TableHeader>
            <TableRow>
              <TableHead>Shortcode</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>URL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.shortcode}>
                <TableCell className="font-mono">{item.shortcode}</TableCell>
                <TableCell className="whitespace-normal">
                  {item.name}
                  {item.parentName && (
                    <Description as="span" size="xs" className="ml-2">
                      {item.parentName}
                    </Description>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {getShortcodeUrl(item.shortcode)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
