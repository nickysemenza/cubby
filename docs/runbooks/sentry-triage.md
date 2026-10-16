# Sentry triage

Use Sentry for runtime evidence and [GitHub Issues](https://github.com/nickysemenza/cubby/issues)
for planned work. These authenticated views cover the `cubby` and `cubby-apple`
projects; keep private event details in Sentry. The
[issue workflow](../agents/issues.md) owns discovery and PR attribution.

## GitHub coverage

| View                                                                                                                                                                           | Search                      | Purpose                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------- |
| [Linked issues](https://nicky-semenza.sentry.io/issues/?project=4508775559135232&project=4512079996846080&query=is%3Alinked&statsPeriod=90d)                                   | `is:linked`                 | Errors associated with external tracker tickets.   |
| [Tracked unresolved issues](https://nicky-semenza.sentry.io/issues/?project=4508775559135232&project=4512079996846080&query=is%3Aunresolved%20is%3Alinked&statsPeriod=90d)     | `is:unresolved is:linked`   | Outstanding errors already represented by tickets. |
| [Untracked unresolved issues](https://nicky-semenza.sentry.io/issues/?project=4508775559135232&project=4512079996846080&query=is%3Aunresolved%20is%3Aunlinked&statsPeriod=90d) | `is:unresolved is:unlinked` | Errors to assess for an existing or new ticket.    |

Linked issue rows show clickable GitHub references. `is:linked` and `is:unlinked`
refer to external trackers generally, not exclusively GitHub. Time and environment
filters limit the results, so these views are not an inventory of every historical
link. Open an issue to inspect its External Links and activity.

## Production and health

- [Production issues](https://nicky-semenza.sentry.io/issues/views/228316/)
  and [regressions](https://nicky-semenza.sentry.io/issues/views/228317/) are saved
  views; verify their project, environment, and time filters before triaging.
- [Web releases](https://nicky-semenza.sentry.io/explore/releases/?project=4508775559135232&environment=production)
  and [Apple releases](https://nicky-semenza.sentry.io/explore/releases/?project=4512079996846080&environment=production):
  open the relevant release for session and crash-free health metrics.
- [Error ingestion statistics](https://nicky-semenza.sentry.io/settings/stats/?project=4508775559135232&project=4512079996846080&environment=production&statsPeriod=7d):
  distinguish filtered events from rate-limited, invalid, and accepted events.
  Missing events do not establish that an error stopped occurring.

For SDK configuration, source maps, and ingestion filtering, see
[Infrastructure](../infrastructure.md).
