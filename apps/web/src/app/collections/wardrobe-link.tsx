import { Link } from "@tanstack/react-router";

import type { DetailRecordOf } from "~/app/_components/entity-detail/detail-record";
import { Button } from "~/components/ui/button";

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
