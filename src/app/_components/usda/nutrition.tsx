import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { NutritionInfo } from "~/schemas/usda";

export const NutritionInfoTable: React.FC<{ n: NutritionInfo }> = ({ n }) => {
  const { nutrientSummary } = n;
  if (nutrientSummary.length === 0) {
    return null;
  }
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
        {nutrientSummary.map((nutrient) => (
          <TableRow key={nutrient.name}>
            <TableCell>{nutrient.name}</TableCell>
            <TableCell className="text-right">{nutrient.amount}</TableCell>
            <TableCell>{nutrient.unit}</TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
};
