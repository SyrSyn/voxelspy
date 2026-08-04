# Fixture and dependency provenance

## Generated fixtures

The source models used by this spike are generated at runtime by `src/canonical.ts`. They are two simple triangulated cuboids: 40 × 30 × 20 mm and 42 × 30 × 20 mm. They contain no third-party model data and may be redistributed under CC0-1.0. The fixed report values, markups, saved view, and figure primitives are original synthetic test data under the repository license.

Generated artifacts are ignored by Git. A session records the generator description, fixture license, source media type, units, transform, byte count, and SHA-256 hash so provenance travels with the synthetic models.

## Dependencies

Versions are pinned in `pnpm-lock.yaml`. License identifiers were checked from installed package metadata.

| Package                              | Use                                                                 | License    |
| ------------------------------------ | ------------------------------------------------------------------- | ---------- |
| `fflate` 0.8.2                       | Deterministic ZIP/DOCX writing and bounded post-preflight inflation | MIT        |
| `zod` 4.0.17                         | Runtime schema and cross-reference validation                       | MIT        |
| `fast-check` 4.3.0                   | Development-only property tests                                     | MIT        |
| `vitest` 3.2.4                       | Development-only test runner                                        | MIT        |
| `typescript` 5.9.2                   | Development-only compiler                                           | Apache-2.0 |
| `eslint` 9.33.0, `@eslint/js` 9.33.0 | Development-only linting                                            | MIT        |
| `typescript-eslint` 8.40.0           | Development-only TypeScript linting                                 | MIT        |
| `@types/node` 24.3.0                 | Development-only Node.js declarations                               | MIT        |

Transitive development dependencies are locked but are not part of the generated runtime artifacts. A production adoption should run the project's standard dependency review and software-bill-of-materials process rather than treating this spike inventory as release approval.
