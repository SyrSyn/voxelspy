# Privacy evidence in this test suite

VoxelSpy's core promise is that comparing two models happens entirely in
the browser: source bytes, normalized geometry, and analysis results never
leave the page. This directory carries the evidence for that promise in
two complementary forms, plus the tests that exercise the rest of the app.

## The behavioral half: `privacy.spec.ts`

`privacy.spec.ts` instruments every page before it runs any application
code and asserts, across the full workflow (every prerendered route, model
import, a comparison run, workbench interaction, report export, session
save, session reopen, and a deliberately corrupt import), that:

- every network request the browser actually issues stays on the page's
  own origin (a Playwright `request` listener, which sees requests
  regardless of which API triggered them — fetch, XHR, `<img>`, CSS,
  worker scripts, `sendBeacon`, …), and
- the app never even _attempts_ an off-origin call through
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, or
  `navigator.sendBeacon` (an init script installed before first paint
  wraps each API and records any target that resolves off-origin), and
- no service worker is ever registered, and
- after a completed comparison, the tab is silent — no request fires
  during a bounded idle window (ruling out a lurking timer, poller, or
  retry loop).

`tests/comparison.spec.ts`, `tests/report-export.spec.ts`, and
`tests/session.spec.ts` add narrower off-origin checks of their own
alongside their functional assertions.

### What this proves

That, as of this snapshot of the code, running the app exactly as a user
would — importing real files, running a real comparison, exporting a real
report, saving and reopening a real session — never sends a single byte
off the page's origin, through any of the network-capable browser APIs
this suite knows to watch.

### What this cannot prove

- That a _future_ dependency won't add network calls. This is a snapshot,
  re-checked on every test run, not a standing guarantee — nothing stops a
  new import in `src/` from calling `fetch`, and the audit will only catch
  it the next time these tests run against that change. The
  Content-Security-Policy below is the attempt at a standing guarantee.
- That every conceivable exfiltration channel is covered. The hooked APIs
  are the realistic set for a browser app (network requests, XHR, fetch,
  WebSocket, EventSource, beacons, service workers); it does not, for
  example, instrument `navigator.sendBeacon`'s more exotic cousins or
  browser-extension-injected channels, which are outside the page's own
  control regardless.
- Anything about server-side or build-time behavior — this only observes
  what ships to and runs in the browser.

## The structural half: `public/_headers`

`public/_headers` ships a Content-Security-Policy (plus `Referrer-Policy`,
`X-Content-Type-Options`, and a conservative `Permissions-Policy`) with
the static build, in the format Cloudflare Pages (and compatible static
hosts) read to attach real HTTP response headers. `scripts/verify-static.mjs`
fails the build if this file goes missing or any directive is dropped, so
a regression can't silently ship. The policy:

```
default-src 'self'; script-src 'self' 'sha256-cOqNf9rQBC2f9uweTItN+UYLKXcmFRduAHEYm3N1MmE=';
style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self';
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

Everything is same-origin only, with two narrow, checked exceptions:

- The `script-src` hash allow-lists exactly one inline script: the early
  theme guard in `index.html`, which reads `localStorage` before first
  paint to avoid a flash of the wrong theme. Its content is identical
  across every prerendered route (verified before choosing a hash rather
  than assumed), so one hash covers the whole site; if that script's text
  ever changes, the hash must be regenerated or the policy breaks the app
  on purpose.
- `img-src` allows `data:` for headroom (e.g. an inlined thumbnail),
  though nothing in the current build actually uses one.

Two directives that seemed likely to need loosening turned out not to:
`style-src` needs no `'unsafe-inline'` (there are no inline `<style>`
elements or `style=""` attributes anywhere in the built output — all
styling is the single linked stylesheet), and `worker-src` needs no
`blob:` (the comparison and summary workers are loaded as same-origin
module URLs via `new Worker(new URL("./x.worker.ts", import.meta.url))`,
not `Blob`/`createObjectURL`, so `'self'` alone covers them).

### Verifying the policy doesn't break the app

`vite preview` (what the default Playwright config runs against) does not
read or send `_headers`, so the policy can't be exercised by the ordinary
`pnpm test:e2e` run. To get real evidence rather than a policy that only
looks right as text:

```sh
pnpm build   # emits dist/, including dist/_headers
npx playwright test --config=playwright.csp.config.ts
```

`playwright.csp.config.ts` runs the _entire_ Playwright suite (same test
files, same projects) against `scripts/csp-preview-server.mjs` — a small
static file server that serves `dist/` and attaches the exact headers
declared in `dist/_headers` to every response, so the browser enforces the
real policy over real HTTP headers. A full green run here means every
script, worker, stylesheet, and connection the app actually uses during
normal operation, workbench interaction, export, and session round-tripping
loads and works under enforcement — not just that the CSP text parses.

At the time this suite was written, this run was green (32/32) on repeat
runs, including a single-worker run. One earlier 2-worker run saw two
transient failures (a route not rendering in time, a comparison not
completing in time) that did not reproduce on rerun and did not correspond
to any CSP violation in the console; that is a resource-contention
limitation of the minimal single-threaded verification server under
parallel Chromium instances, not a policy failure — see the caveats in
`scripts/csp-preview-server.mjs`.

### What this cannot prove

- That the deployed host actually honors `_headers`. The file only takes
  effect on a host that reads and serves it (Cloudflare Pages and
  compatible hosts); on a host that ignores it, the CSP simply never
  applies, and the site falls back to the behavioral guarantee above.
- `frame-ancestors`: enforcing this requires a second origin attempting to
  frame this one, which the verification server does not set up. The
  directive is present and correct as declared, but not exercised here.
- Full Cloudflare Pages glob-matching and rule-precedence semantics for
  `_headers` — the verification server implements only the single `/*`
  rule this project currently declares.
- Anything about hosts that rewrite or strip headers in transit (some CDNs
  and proxies do).

## Everything else in this directory

`comparison.spec.ts`, `report-export.spec.ts`, and `session.spec.ts` cover
functional correctness and UX — import flow, workbench rendering, capacity
guidance, report export content, and session save/reopen fidelity — with
their own off-origin spot-checks layered in. `privacy.spec.ts` is the
dedicated, comprehensive pass over the same workflows specifically for the
local-processing guarantee.
