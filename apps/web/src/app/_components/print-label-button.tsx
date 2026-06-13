import { Link } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { Button } from "~/components/ui/button";

/**
 * The "Print Label" action: an outline button linking to /labels for a single
 * shortcode. Renders nothing when there's no shortcode. Shared by the product
 * and location info views (callers apply any extra gating, e.g. QR support).
 */
export function PrintLabelButton({
  shortcode,
}: {
  shortcode: string | null | undefined;
}) {
  if (!shortcode) return null;
  return (
    <Button
      variant="outline"
      render={<Link to="/labels" search={{ codes: shortcode }} />}
      nativeButton={false}
    >
      <Printer className="mr-2 h-4 w-4" />
      Print Label
    </Button>
  );
}
