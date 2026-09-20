/**
 * Most browser acceptance does not boot the Flue runtime, but the web Worker
 * must retain its production service-binding shape. This local peer keeps the
 * binding resolvable and makes an accidental agent request fail explicitly.
 */
export default {
  fetch(): Response {
    return Response.json(
      { error: "Purchase Agent is not enabled in this E2E harness" },
      { status: 503 },
    );
  },
};
