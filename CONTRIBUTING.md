# Contributing to VoxelSpy

VoxelSpy welcomes focused bug reports, test cases, documentation improvements, design feedback, and code contributions. The project is early: open an issue before investing in a new public API, geometry algorithm, file-format dependency, or large user-interface direction.

## Development setup

Use Node.js 24 or newer with Corepack enabled.

```sh
corepack enable
pnpm install
pnpm check
```

Keep dependency updates intentional and include the lockfile. Do not depend on undeclared global tools in repository scripts.

## Evidence expectations

Geometry and format changes should include the smallest distributable fixture that demonstrates the behavior, expected measurements with tolerances, and provenance for both the fixture and expected result. Record whether a result is exact, approximate, or indeterminate and preserve relevant importer and algorithm settings.

User-interface changes should be checked in supported themes and representative desktop and touch layouts. Changes to workers, archives, or reports should cover cancellation, malformed input, size limits, deterministic output where promised, and fallback behavior.

## Pull requests

- Keep the scope narrow and explain the user-visible outcome.
- Add or update tests and documentation with the implementation.
- Include verification commands and observed results.
- Call out compatibility, privacy, security, licensing, performance, and accessibility effects.
- Avoid drive-by refactors and generated changes unrelated to the contribution.

All submitted work must be compatible with the repository license and must not contain confidential data, proprietary models, secrets, or personalized infrastructure details.
