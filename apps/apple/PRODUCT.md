# Cubby on Apple platforms

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

A two-person household uses Cubby repeatedly to find, record, organize, and
review household information. Core tasks must make sense without knowing the
underlying entity model. Frequent users also need efficient keyboard, selection,
search, and bulk-edit workflows.

## Product Purpose

Connect household belongings, places, food, tasks, projects, purchases, and money
so members can find context and complete work without reconstructing it across
separate records. The native app supports quick use on a phone and sustained
review on a Mac.

## Operating Context

iPhone emphasizes capture, lookup, and small corrections. Mac emphasizes
comparison, review, bulk operations, and keyboard use. Core capabilities remain
available on both; navigation and presentation adapt to each platform rather
than stretching the phone layout across a desktop. iPad adapts to its available
window space and input methods.

## Capabilities and Constraints

The [README tenets](../../README.md#tenets) own household and data rules.
Useful capabilities, household data, money, source evidence, and explicit member
decisions survive interface and contract changes. Backend changes and migrations
are appropriate when they materially improve the workflow.

Native, hosted, and browser boundaries are design choices to evaluate against
usability and maintenance cost. A boundary change preserves authentication,
navigation context, drafts, recovery, and the underlying capability.

Improve the web app alongside native when a shared workflow, declaration, or
handoff benefits. Keep shared terminology and behavior consistent while using
each client's own interaction patterns; the web design system remains owned by
[the web design document](../web/DESIGN.md).

## Product Principles

- Make the task and next useful action understandable before optimizing density.
- Use compact defaults, clear grouping, and useful information instead of
  repeated headings, decorative containers, or unnecessary navigation.
- Build on each Apple platform's familiar controls and interactions.
- Preserve readable text, accessible targets, keyboard access, and large-text
  layouts while reducing wasted space.
- Treat loading, empty, error, disabled, and recovery states as part of the
  finished experience, alongside typography, alignment, symbols, and motion.

## Brand Commitments

Keep Cubby's identity restrained and content-led. Use system-native Apple
presentation, with character in information hierarchy, imagery, precise wording,
and selective color. [DESIGN.md](DESIGN.md) owns the implemented visual system.

## Evidence on Hand

SwiftUI previews and generated synthetic fixtures support visual review without
household records. Preview captures establish appearance, not successful writes
or interaction behavior. Existing native journeys and stored-result read-back
provide the corresponding workflow evidence.
