import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/docs")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `<!doctype html>
<html><head><title>Cubby API</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="app"></div><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.68.0"></script>
<script>Scalar.createApiReference('#app', { url: '/api/v1/openapi.json', persistAuth: false, telemetry: false, proxyUrl: '' })</script></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    },
  },
});
