# Local team service implementation proposal

Status: approved and implemented as a local integrated self-hosted suite.
The eight shared tools, exact revision loading, immutable tool artifacts,
authored-session reopening, current authorization and local upgrade/restore
workflows are qualified. See [the inventory](INVENTORY.md) for observed checks.
Physical devices, public hosting and off-host recovery remain unqualified.

## Foundation and scope

Use [demo-starter-tanstack](https://github.com/formless63/demo-starter-tanstack)
for a separate `voxelspy-pdm` application. Its React foundation fits VoxelSpy's
existing React and framework-independent packages. The Nuxt alternative is
viable but would require a second UI framework for this integration.

This is a local, private review installation. Source pushes use separate
maintainer authorization. It does not add a domain or change the browser
toolkit's independent local-only behavior.
Source and running configuration remain separate under the server's project
and stack conventions. No existing service or real-data database is reused.

## User-visible workflows and data

- Passwordless local sign-in through captured magic links. Mailpit never relays
  mail externally. External OAuth/OIDC remains unconfigured.
- Create a private workspace, invite members, and create projects in it. Owners
  manage membership; editors add revisions and review evidence; viewers inspect
  and download permitted data. Authorization applies at each server operation,
  including direct download and machine requests, not only route navigation.
- Upload a supported model explicitly to a named project. Show destination,
  source name, size and digest before creating its immutable revision record.
  Upload limits match the toolkit; server-generated storage keys never trust
  file names, client digests or client-supplied ownership.
- List revision ancestry and select exact revisions for any of the eight shared
  tools: Compare, Inspect, Mesh Health, Measure & Section, Clearance & Fit,
  Printability, File Forensics and Convert. Download their bytes deliberately
  into the browser and use the same toolkit UI, workers and pinned engines.
- Explicitly retain source-bound tool evidence, HTML, converted attachments and
  source-embedding comparison sessions. Reopen sessions with their exact source
  pair, callouts, distance markups and named camera views. Artifact comments
  append to immutable history; HTML is downloaded rather than rendered inline.
- Attach versioned review reports and comments to exact revision pairs. Record
  authorship and append-only audit events. Revisions and evidence are immutable;
  a correction produces a new revision or review event.
- Archive projects without deleting model history. Provide an operator backup
  and restore procedure covering database and private objects consistently.

The initial service does not claim CAD authoring, PLM/ERP workflows, public
sharing, billing, unattended server geometry execution, or production readiness.
Those are outside the defined PDM workflows rather than implied by its name.

## Starter capability plan

Select `jobs`, `object-storage`, `email`, `audit-log`, `organizations`,
`authorization`, `file-ui`, `data-table` and `ops-admin`. `file-ui` requires
`object-storage`; the other selected capabilities have no additional hard
capability dependencies. Preserve the starter's baseline TanStack Start,
PostgreSQL/Drizzle, passwordless Better Auth, strict TypeScript and Bun tooling.

Defer `api-platform`, `observability`, `search`, `realtime`, `notifications`,
`import-export`, `command-system`, `markdown-code`, `charts-visualization`,
`rich-text`, `internationalization` and `feature-flags` until their workflows
are needed. Exclude `webhooks`, `ai`, `cache-coordination`, `invoice-ninja`,
`stripe`, `medusa`, `flow-canvas` and `pwa-offline` from the initial app.
Use a clean generated consumer with explicitly selected capabilities; do not
ship the starter's full reference demo as the PDM application.

Use the selected starter's existing schema/profile and capability tools to
record this plan. Migrations are additive and preserve the original PDM
installation. Other applications and databases are not reused or reset.

## Appearance and guidance

Preserve VoxelSpy's technical identity with a compact, responsive project and
revision layout. Support Light, Dark and System with user selection, system
font stacks, visible keyboard focus and textual equivalents for canvas views.
No font or analytics provider is added.

Keep the starter's canonical repository guidance and applicable baseline
workflows. No external skill, client hooks, MCP configuration, permissions or
agent settings are imported from VoxelSpy or another project. The incoming
external-skill count is zero; framework-specific advice remains in its own repo.

## Local runtime and acceptance

Use isolated, explicitly named application, PostgreSQL, worker, private object
storage and Mailpit services. Publish review ports only on loopback; no public
Pangolin route is required. Store real configuration outside Git. Run explicit
one-shot migration jobs before app/worker start. Do not migrate during startup.

Acceptance requires real passwordless sign-in, two-user/workspace authorization
denials, immutable revision and digest checks, safe upload/download limits,
all eight shared tools, exact-source artifact/session reopening, STEP frame
provenance, archive/history retention,
keyboard/phone workflows, no unintended external traffic, and a verified local
backup/restore rehearsal. Run the starter's profile, theme, capability and normal
checks and appropriate database/browser tests. Record unresolved requirements
and external device/hosting evidence separately.
