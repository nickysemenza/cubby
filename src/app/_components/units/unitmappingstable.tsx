import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { UnitMapping } from "~/schemas/unitmapping";

import { useWasm } from "~/hooks/useWasm";
import { NoneState } from "../NoneState";

export const UnitMappingsTable: React.FC<{
  mappings: UnitMapping[];
}> = ({ mappings }) => {
  const w = useWasm();

  return (
    <Table className="table-auto text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>a</TableHead>
          <TableHead>b</TableHead>
          <TableHead>source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mappings.length === 0 && (
          <TableRow>
            <TableCell colSpan={3} className="text-center">
              <NoneState />
            </TableCell>
          </TableRow>
        )}
        {mappings.map((unitMapping, x) => {
          return (
            <TableRow key={`${x}-${unitMapping.source}`}>
              <TableCell>{w.format_amount(unitMapping.a)}</TableCell>
              <TableCell>{w.format_amount(unitMapping.b)}</TableCell>
              <TableCell>{unitMapping.source}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};
