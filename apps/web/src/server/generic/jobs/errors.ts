/** Pure control signals shared with providers without importing the database runtime. */
export class JobPausedError extends Error {}
export class JobDeferredError extends Error {
  constructor(
    message: string,
    readonly until: Date,
  ) {
    super(message);
  }
}
export class JobSupersededError extends Error {
  constructor() {
    super("Job generation or lease is obsolete");
  }
}
