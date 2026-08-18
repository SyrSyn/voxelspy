# Tier 1 release evidence

This record summarises the verification behind the first browser-local
comparison release, and states plainly what has not been observed. It exists
so the release decision rests on evidence rather than recollection.

Nothing here authorises publication, deployment, or a domain change. Those
remain maintainer decisions.

## What the release contains

Two supported source formats are imported locally, normalised into an
explicit engineering frame with the chosen interpretation attached to the
result, and compared by sampled surface distance in a dedicated worker.
Ranked change regions, measurements, provenance, warnings, and uncertainty
are presented together in synchronised difference, baseline, and candidate
views. A completed comparison can be cancelled while running, exported as one
self-contained report document, or saved as a portable session that reopens
without re-running analysis.

## Verification observed

| Area                 | Evidence                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository checks    | Format, lint, typecheck, unit, and build tasks pass across every package                                                                                                                                                  |
| Unit coverage        | 287 tests: contracts 53, analysis 66, importers 41, session archive 59, web 68                                                                                                                                            |
| Browser coverage     | 72 tests across desktop and mobile projects, 1 skipped by design                                                                                                                                                          |
| Geometry correctness | Property tests prove the spatial index returns exact brute-force nearest distances across hostile clouds, and the point-to-triangle routine matches hand-derived values in all seven regions and an independent reference |
| Honest semantics     | Adversarial fixtures pin thin walls, flipped winding, coincident and duplicated surfaces, one-ulp fragmentation, internal voids, mixed tessellation, and the exact solid adapter's acceptance boundary                    |
| Sampling limits      | Results report a numeric worst-case sample spacing against the requested tolerance and warn when features below that size can be missed                                                                                   |
| Resource limits      | A benchmark tier completes the documented one-million-triangle ceiling within its memory estimate and guards it against regression                                                                                        |
| Input robustness     | Truncated, oversized, non-finite, malformed, and non-text inputs fail closed; safety ceilings are exercised without allocating their payloads                                                                             |
| Archive security     | A stored-only profile with reader and writer parity, byte-range overlap and gap detection, and full manifest-mismatch coverage                                                                                            |
| Recovery             | Worker load failure, cancellation of in-flight work, three consecutive runs, reload mid-comparison, and corrupt import and session archives all leave the application usable                                              |
| Privacy              | Every route and the full workflow, including export and session save and reopen, produce no off-origin request or attempted request; the build ships a policy with no inline allowances and fails if it is dropped        |
| Accessibility        | Landmarks, headings, skip-link focus, keyboard path through the whole workflow, live regions, canvas text alternatives, non-colour semantics, reduced motion, touch targets, and contrast in both themes                  |
| Determinism          | Identical inputs produce identical analysis results, identical session bytes, and identical exported documents                                                                                                            |

## Not observed

- **Engines other than Chromium.** The suite is authored to run on every
  engine and under the shipped headers in continuous integration, but only
  Chromium results have been observed; the other engines cannot be installed
  in the current development environment. Tracked as `voxelspy-ft9.1.5.11`.
- **Continuous integration runs.** The workflow is authored but cannot run
  until the repository is published.
- **A deployment target.** The runbook and hosting artifacts exist and are
  verified locally; no origin, domain, preview deployment, or header
  enforcement by a real host has been exercised.
- **Real devices.** Capability recommendations and mobile behaviour are
  verified through emulation, not physical hardware.
- **Formats beyond the two implemented.** Everything else in the project
  direction remains unimplemented, and the readme says so.

## Known accepted limitations

- Sampled surface distance is approximate. Finding no changed regions means
  no change was observed at the reported sampling density, never proof of
  equality; the result states the spacing bound that qualifies it.
- Unsigned distance cannot distinguish a cavity from an inserted shell, and a
  candidate with reversed winding compares as unchanged. Both are pinned by
  fixtures.
- Region connectivity is bit-exact, so coordinates differing by one unit in
  the last place separate regions rather than joining them.
- The memory ceiling is a structural cost model with a stated margin, not a
  byte-exact prediction; observed use varies with collection timing and mesh
  shape.
- Two text-format behaviours await a policy decision: input missing its
  closing marker is accepted, and a text file whose length matches the binary
  layout is read as binary. Tracked as `voxelspy-ft9.1.4.1.1`.
- Reports carry no markups or figures because no annotation feature exists;
  the session and report contracts reserve the shape.

## Decision

Release readiness is ready for maintainer review. The implemented workflow is
verified end to end on one engine with the evidence above. Accepting it means
accepting the limitations listed here, and accepting that cross-engine and
hosted behaviour will be observed only once the repository is published and a
target exists.
