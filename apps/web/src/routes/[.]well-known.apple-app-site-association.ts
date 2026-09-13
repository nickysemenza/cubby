import { createFileRoute } from "@tanstack/react-router";

import { GET } from "~/server/apple-app-site-association";

// Apple universal links: iOS/macOS fetch this unauthenticated, unversioned
// path over HTTPS before opening a `cubby.nickysemenza.com/<SHORTCODE>` link
// from a printed label QR code, to decide whether to hand it to the native
// app instead of Safari.
export const Route = createFileRoute("/.well-known/apple-app-site-association")(
  {
    server: {
      handlers: {
        GET,
      },
    },
  },
);
