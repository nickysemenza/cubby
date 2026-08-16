import { Link } from "@tanstack/react-router";
import { VerbButton } from "./actions/action-verb-ui";

/**
 * The Print label action: an outline button linking to /labels for a single
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
    <VerbButton
      verb="printLabel"
      render={<Link to="/labels" search={{ codes: shortcode }} />}
    />
  );
}
