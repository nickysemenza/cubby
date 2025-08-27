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
          <TableHead className="p-0.5">a</TableHead>
          <TableHead className="p-0.5">b</TableHead>
          <TableHead className="p-0.5">source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mappings.length === 0 && (
          <TableRow>
            <TableCell colSpan={3} className="p-0.5 text-center">
              <NoneState />
            </TableCell>
          </TableRow>
        )}
        {mappings.map((unitMapping, x) => {
          return (
            <TableRow key={`${x}-${unitMapping.source}`}>
              <TableCell className="p-0.5">
                {w.format_amount(unitMapping.a)}
              </TableCell>
              <TableCell className="p-0.5">
                {w.format_amount(unitMapping.b)}
              </TableCell>
              <TableCell className="truncate p-0.5">
                {unitMapping.source}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};
