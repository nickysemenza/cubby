import * as Sentry from "@sentry/tanstackstart-react";

Sentry.init({
  dsn: "https://a50b2f76dd1586f95cdd29cd13a6c0dc@o83311.ingest.us.sentry.io/4508775559135232",
  sendDefaultPii: true,
  tracesSampleRate: 1.0,
});
