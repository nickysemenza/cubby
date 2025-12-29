import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";

export function LocationActions() {
  return (
    <Link to="/locations/new">
      <Button>Create New Location</Button>
    </Link>
  );
}
