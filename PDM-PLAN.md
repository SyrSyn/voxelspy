# Local team service implementation proposal

Status: approved and implemented as a separate local prototype. Authorization,
immutable history, desktop/emulated-phone workflows and same-version local
backup/restore have been qualified. See [the inventory](INVENTORY.md) for observed
checks and remaining acceptance boundaries. The prototype uses a historical
five-format engine snapshot; STEP and the toolkit's newer review authoring are
not integrated into that snapshot. Physical devices, public hosting and off-host
recovery remain unqualified.

## Foundation and scope

Use [demo-starter-tanstack](https://github.com/formless63/demo-starter-tanstack)
for a separate `voxelspy-pdm` application. Its React foundation fits VoxelSpy's
existing React and framework-independent packages. The Nuxt alternative is
viable but would require a second UI framework for this integration.

This is a local, private review installation. It does not publish a repository,
add a domain, or change the browser toolkit's local-only comparison behavior.
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
- List revision ancestry and select two exact revisions for local comparison.
  Download their bytes deliberately into the browser and use the existing
  engines; never run arbitrary model code on the server.
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
record this plan. New migrations are additive against this new installation;
there is no migration or reset of any existing application.

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
revision-pair comparison and report attachment, archive/history retention,
keyboard/phone workflows, no unintended external traffic, and a verified local
backup/restore rehearsal. Run the starter's profile, theme, capability and normal
checks and appropriate database/browser tests. Record unresolved requirements
and external device/hosting evidence separately.
