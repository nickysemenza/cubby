import type { NutritionInfo } from "@recipehub/usda-schemas";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Table,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

export const NutritionInfoTable: React.FC<{
  n: NutritionInfo;
  limit?: number;
}> = ({ n, limit }) => {
  const { nutrientSummary } = n;
  if (nutrientSummary.length === 0) {
    return null;
  }
  const items = limit ? nutrientSummary.slice(0, limit) : nutrientSummary;
  const remaining = nutrientSummary.length - items.length;
  return (
    <ScrollArea className="w-full rounded-md border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[100px] max-w-[200px]">
              Nutrient
            </TableHead>
            <TableHead className="min-w-[60px] text-right">Amount</TableHead>
            <TableHead className="min-w-[40px]">Unit</TableHead>
          </TableRow>
        </TableHeader>
        <tbody>
          {items.map((nutrient) => (
            <TableRow key={`${nutrient.name}-${nutrient.unit}`}>
              <TableCell className="max-w-[200px] truncate">
                {nutrient.name}
              </TableCell>
              <TableCell className="text-right">{nutrient.amount}</TableCell>
              <TableCell>{nutrient.unit}</TableCell>
            </TableRow>
          ))}
        </tbody>
        {remaining > 0 && (
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3} className="text-right">
                {remaining} more nutrients
              </TableCell>
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </ScrollArea>
  );
};
