# Static deployment

The web application builds to a directory of static files. It needs no
application server, serverless runtime, database, or provider-specific
rewrite rule. Any host that serves files and honours a headers file can serve
it; the examples below use the Cloudflare Pages `_headers` format the build
already emits.

Publishing this repository, creating a deployment target, and pointing a
domain at it are maintainer decisions and are not performed automatically.

## Build output

```sh
pnpm install --frozen-lockfile
pnpm --filter @voxelspy/web build
```

The build emits `apps/web/dist`:

- one `index.html` per declared route, so a deep link returns its own
  prerendered document rather than a client-side redirect;
- `404.html` for unmatched paths;
- `assets/` containing content-hashed JavaScript, CSS, and worker chunks;
- `_headers`, `favicon.svg`, and `robots.txt`.

`scripts/verify-static.mjs` runs as the final build step and fails the build
if a route is missing prerendered content, metadata, or the early theme
guard; if the security headers are absent, weakened, or missing a required
directive; if an inline script is not covered by a policy hash; or if the
caching rules are missing.

## Host configuration

| Setting          | Value                                               |
| ---------------- | --------------------------------------------------- |
| Build command    | `pnpm --filter @voxelspy/web build`                 |
| Output directory | `apps/web/dist`                                     |
| Node version     | 24 or newer                                         |
| Install command  | `corepack enable && pnpm install --frozen-lockfile` |
| Framework preset | None                                                |

Requirements the host must satisfy:

- **Serve the headers file.** The content security policy is the structural
  half of the local-processing guarantee. A host that ignores `_headers`
  serves a working site with a weaker boundary, so confirm the headers
  arrive in a response before treating a target as production.
- **Do not rewrite all paths to one document.** Each route has its own
  prerendered file. A catch-all rewrite would serve the wrong prerendered
  content and defeat deep linking.
- **Serve `404.html` for unmatched paths.**
- **Do not inject scripts, analytics, or edge personalisation.** Any injected
  inline script is blocked by the policy, and any injected third-party
  request breaks the audited network boundary.

## Verification before cutover

Run against the deployment target, not only a local build:

1. `pnpm --filter @voxelspy/web build` completes, including static
   verification.
2. From `apps/web`, `pnpm exec playwright test` passes, and
   `pnpm exec playwright test --config=playwright.csp.config.ts` passes with
   the real headers applied.
3. Fetch response headers for a route document and for a hashed asset, and
   confirm the policy, referrer policy, content-type options, permissions
   policy, and the two cache-control values arrive as configured.
4. Load each route directly by URL, including a trailing-slash deep link,
   and confirm the prerendered document is returned before JavaScript runs.
5. Request an unmatched path and confirm the 404 document is served.
6. Complete one comparison on the deployed origin with the browser network
   panel open and confirm no off-origin request occurs.
7. Confirm the theme guard applies without a flash in light, dark, and
   system settings.

## Cutover

1. Deploy to a preview URL and complete the verification list there.
2. Deploy the same commit to the production target and repeat the header,
   deep-link, and comparison checks.
3. Point the domain at the target, then repeat the header and deep-link
   checks on the domain itself, since headers and redirects are commonly
   configured per hostname.
4. Record the released commit and the observed verification results.

## Rollback

Static output is content-addressed and self-contained, so rollback is
redeploying the previous build; no migration or data restore is involved.
Because route documents are served with `no-cache`, a rollback is visible on
the next request rather than after a cache lifetime. Hashed assets from the
previous build remain valid, so a rollback does not strand a client that has
already loaded one.
