# Security policy

VoxelSpy is pre-release software and does not yet publish supported release lines.

## Reporting a vulnerability

Security reporting instructions will be published before the first release. Until then, do not post suspected vulnerabilities or sensitive reproductions in public issues.

Once a private reporting channel is available, maintainers will acknowledge complete reports, investigate them, and coordinate disclosure after a fix or mitigation is available. No response-time guarantee is offered while the project is pre-release.

## Security boundaries

The browser application is intended to process untrusted model and session files locally. Importers, archive readers, workers, report generation, and WebAssembly dependencies must enforce explicit resource limits and fail safely. File contents, filenames, metadata, and embedded resources are untrusted input.

Normal comparison is intended not to upload model data. Any feature that introduces network transfer, remote assets, telemetry, identity, storage, or server-side processing must make that behavior explicit and receive security and privacy review before release.
