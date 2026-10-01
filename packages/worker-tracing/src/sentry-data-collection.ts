/**
 * Sentry 11 replaced `sendDefaultPii` with `dataCollection`, and an unset
 * `dataCollection` now collects request bodies, cookies, user info, database
 * query data, and GenAI inputs by default. Every Cubby Sentry init uses this
 * object to keep the v10 `sendDefaultPii: false` baseline (copied from the
 * Sentry v10 to v11 migration guide).
 */
const IP_AND_USER_HEADERS = {
  deny: ["forwarded", "-ip", "remote-", "via", "-user"],
};

export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: IP_AND_USER_HEADERS,
    response: IP_AND_USER_HEADERS,
  },
  httpBodies: [],
  urlQueryParams: IP_AND_USER_HEADERS,
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
};
