import { Link } from "@tanstack/react-router";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { Button } from "~/ui/primitives/button";

export function WardrobeLink({
  record,
}: {
  record: DetailRecordOf<"ledgerParty">;
}) {
  return (
    <Button
      variant="outline"
      render={
        <Link to="/collections/wardrobe/$owner" params={{ owner: record.id }} />
      }
    >
      Open wardrobe
    </Button>
  );
}
