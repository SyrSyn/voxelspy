# Contributor guide

This file is the canonical repository guidance for maintainers, contributors, and automated development tools.

## Working principles

- Keep changes focused, reviewable, and within the accepted issue or task scope.
- Treat geometry correctness, user privacy, security boundaries, public APIs, schemas, and release behavior as explicit review gates.
- Prefer evidence from fixtures, tests, benchmarks, and rendered behavior over assumptions.
- Keep core analysis and serializable data contracts independent of React, browser-only file types, hosting, identity, and persistence.
- Preserve source units, coordinate transforms, warnings, provenance, and uncertainty. Never silently recenter, rescale, align, repair, or reinterpret geometry.
- Require format importers to return normalized typed-array geometry with explicit units, transforms, warnings, and provenance. Optional assembly data must remain serializable.
- Select geometry algorithms through adapters with validated preconditions; no Boolean, voxel, or distance method is the universal comparison path.
- Keep reports, findings, markups, saved views, and portable-session schemas versioned and serializable from their first accepted implementation.
- Support transferable-buffer worker transport as the baseline. Shared memory may accelerate supported environments but must not be required.
- Keep local browser comparison independent of hosted identity, storage, and server APIs.
- Keep heavy geometry buffers and computation outside UI state and render loops.

## Public-safety rules

Everything committed to Git or recorded in the shared issue tracker must be suitable for a permanent public history.

- Never include secrets, private notes, local absolute paths, machine or network names, personal infrastructure details, unpublished credentials, or copied private planning text.
- Use generic examples and repository-relative paths.
- Do not commit source models unless their redistribution terms and provenance are documented.
- Do not publish repositories, push branches, create releases, deploy, alter hosting, or change DNS without explicit maintainer authorization.
- Stop and request review before destructive actions, externally visible changes, migrations, or changes that materially alter product outcomes.

## Collaboration

- Isolate parallel editing with branches or worktrees and assign non-overlapping file ownership.
- Define the outcome, allowed files, dependencies, acceptance criteria, and verification commands before delegating a work item.
- Do not broaden a work item silently. Record evidence and escalate unresolved contract conflicts for maintainer review.
- Shared configuration, lockfiles, schemas, migrations, release metadata, and public contracts require coordinated integration.
- Research prototypes are evidence, not accepted APIs. Keep disposable work clearly separated until its conclusions are reviewed.

## Verification

Run the narrowest relevant checks during development and the repository-wide check before handoff:

```sh
pnpm check
```

When applicable, also verify fixture provenance, deterministic outputs, hostile-input limits, cancellation and recovery, accessibility, browser fallbacks, and that normal comparison does not transmit model data.

Report what changed, commands run, evidence observed, and any remaining risk. Do not describe work as complete when required checks were skipped or the user-visible workflow was not exercised.

## Commit quality

- Keep commits cohesive and understandable without private context.
- Use neutral, durable language suitable for an upstream public project.
- Inspect staged content and history for sensitive or personalized data before every commit.
- Do not mix generated artifacts, unrelated formatting, or local environment changes into a feature commit.
