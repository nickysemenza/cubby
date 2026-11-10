# ADR 0014: Start only the CI lanes whose inputs changed

Status: Superseded by [ADR 0020](0020-cache-routed-ci.md). Accepted 2026-10-12.

## Decision

A planning job diffed the tested tree against the last policy-verified
successful `main` run and started only the required CI lanes whose Nx inputs
changed, while the content-hashed Nx cache from
[ADR 0009](0009-content-hash-merge-gate.md) still decided whether a started lane
reran. ADR 0020 replaced path routing with cache-routed lanes.

The full text is in git history.
