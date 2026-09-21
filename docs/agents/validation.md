# Validation, CI, and delivery

Choose the lowest tier that can expose the changed behavior. Use real
implementations; mocks are for external seams that cannot run locally. A test
belongs only when it catches a behavior regression the type system cannot.

## During implementation

Run one affected web test from the repository root with `pnpm test:file
src/...`; paths are relative to `apps/web`. For PostgreSQL contracts use `pnpm
test:file:postgres src/...`. Read a failed run's ending and
`apps/web/.vitest-failures.txt` before deciding what to change; do not rerun an
unchanged tier to rediscover its failures.

One root agent owns the final join. Subagents run only focused `pnpm test:file`
tests and return their result, command, duration, relevant output, and limits.
The root runs affected tests and one `pnpm check`, reusing valid caches. Never
run expensive gates in parallel. Hooks are mandatory: pre-commit runs `pnpm
check`; pre-push runs `pnpm verify:push`; never bypass either.

`pnpm verify:local` is the clean-tree full diagnostic, and
`pnpm verify:local:full` forces uncached verification. GitHub Actions must pass
on the exact final PR head before merge. Report unrun or unavailable checks as
such.

## Load when needed

- [Test tiers and browser/database traps](validation-tests.md) for a new test,
  changed `.tsx`, PostgreSQL, E2E, WASM, or package test work.
- [Quality and local diagnostics](validation-quality.md) for lint/type failures,
  dependencies, generated surfaces, or broad local verification.
- [PR, CI, and device acceptance](validation-delivery.md) for a PR, failing
  hosted check, deployment path, or phone/PWA behavior.
