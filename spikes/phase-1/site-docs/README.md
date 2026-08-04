# Site and documentation evidence shell

This bounded prototype validates a Vite, React Router, and static-prerender direction for the public site and documentation. It is not the accepted application architecture.

## Run locally

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm dev
```

Use `pnpm check` to type-check, build, prerender, and verify the static output. Install the browser runtime and run the desktop and mobile browser checks with:

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

## What this proves

- One static build contains `/`, `/tools/`, `/docs/`, and the linked documentation routes.
- Route HTML contains meaningful prerendered content, titles, and descriptions before JavaScript runs.
- An inline head guard resolves system, light, or dark preference before the application renders.
- Documentation search runs entirely from a bundled local index.
- File selection is local-only; there is no hosted identity, model upload, or model/session persistence integration.
- The unfinished comparison action stays visible and identifies that the geometry engine is not connected.
- The voxel-eye mark remains legible in small, monochrome, light, and dark treatments.

## Documentation framework decision

Fumadocs is not integrated in this prototype. Its official setup supports React Router and Vite-based Fumadocs MDX, but the React Router path expects framework route configuration, Tailwind CSS, providers, and a search route. This prototype intentionally tests a conventional Vite SPA with an explicit static renderer, so adopting that setup would replace rather than validate the chosen build surface. The small guide set does not yet justify the additional content pipeline.

The content boundary is deliberately narrow: serializable page records feed both routes and a local search index. This is a fallback adapter, not a claim that Fumadocs is incompatible. A future accepted application can replace it with Fumadocs, another content compiler, or a repository-native Markdown pipeline while preserving route and search behavior. Revisit the decision when versioned Markdown, generated API reference, navigation automation, or many contributors make the maintenance cost worthwhile.

## Static-host behavior

The build emits a real `index.html` at every declared route. Canonical non-root paths include a trailing slash, so direct requests to `/tools/`, `/docs/`, and each guide do not depend on a fallback rewrite or redirect. Internal links preserve that convention. Unknown client-side routes render the not-found view during navigation; a future host should supply its own static `404.html` or routing rule once hosting is in scope.

## Open contracts

- The production origin is intentionally unset. The preview card uses a root-relative asset; add canonical, Open Graph URL, and an absolute social-image URL only when a public origin is approved.
- The geometry engine, importer capabilities, report schemas, and worker protocol remain outside this prototype.
- The current in-memory search is appropriate for a small guide set. Larger documentation needs a generated index and relevance strategy.
- The checked-in dependency graph passes `pnpm --ignore-workspace audit`. React Server Components, server actions, and request handling remain outside this static shell; re-run the audit before promoting the prototype.
