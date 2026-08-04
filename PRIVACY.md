# Privacy

VoxelSpy is being built as a local-first 3D comparison tool.

## Browser application

The intended default behavior is:

- Model parsing, normalization, analysis, rendering, and report preparation happen on the user's device.
- Normal comparison does not upload source models, derived geometry, markups, or reports.
- The application does not require an account for local comparison.
- Any network requests, remote assets, update checks, telemetry, crash reporting, or optional integrations must be documented and auditable before release.

These statements describe release requirements for the unfinished application. They are not a guarantee about unreviewed development builds or third-party browser extensions.

Loading a hosted web application still exposes ordinary request metadata, such as IP address, user agent, requested path, and timing, to the hosting provider. Telemetry, crash reporting, remote fonts or assets, and automatic update checks are not implicit exceptions: introducing any of them requires explicit documentation and privacy review. Telemetry and diagnostics must not include source or derived geometry, model contents, filenames, markups, report contents, portable sessions, or stable model hashes.

Exported reports may contain rendered views, measurements, filenames, notes, and other review content. Self-contained portable sessions include their source models. Users should treat both as potentially sensitive and review them before sharing.

## Future services

Any future hosted integration or self-hosted collaboration service will document its data flows, retention, access controls, and operator responsibilities separately. Static browser functionality must not silently become dependent on such a service.

## Contributions and diagnostics

Do not attach proprietary models, portable sessions, reports, or logs containing sensitive filenames or metadata to public issues. Prefer minimal synthetic reproductions. Diagnostic collection must be opt-in and must show users what will be shared.
