import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { UnitMapping } from "~/schemas/unitmapping";

import { wasm } from "~/wasmContext";
import { NoneState } from "../NoneState";

export const UnitMappingsTable: React.FC<{
  mappings: UnitMapping[];
  w: wasm;
}> = ({ mappings, w }) => {
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
