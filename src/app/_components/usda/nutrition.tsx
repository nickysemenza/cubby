import {
  Table,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { NutritionInfo } from "~/schemas/usda";

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
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>Nutrient</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Unit</TableHead>
        </TableRow>
      </TableHeader>
      <tbody>
        {items.map((nutrient) => (
          <TableRow key={`${nutrient.name}-${nutrient.unit}`}>
            <TableCell>{nutrient.name}</TableCell>
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
  );
};
