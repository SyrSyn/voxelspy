import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { Wordmark } from "./Brand";
import { ComparisonFlow } from "./ComparisonFlow";
import { docs, searchDocs, type DocPage } from "./content";

type ThemePreference = "system" | "light" | "dark";

const baseMetadata = {
  "/": {
    title: "VoxelSpy — Private 3D model comparison",
    description:
      "Inspect 3D model revisions locally and keep source geometry on your device.",
  },
  "/compare/": {
    title: "Compare models — VoxelSpy",
    description:
      "Choose a baseline and candidate for private, browser-local comparison.",
  },
  "/docs/": {
    title: "Documentation — VoxelSpy",
    description:
      "Understand VoxelSpy privacy, import, and geometry interpretation boundaries.",
  },
} as const;

function resolveMetadata(path: string) {
  const doc = docs.find((item) => item.path === path);
  if (doc)
    return { title: `${doc.title} — VoxelSpy`, description: doc.description };
  return (
    baseMetadata[path as keyof typeof baseMetadata] ?? {
      title: "Page not found — VoxelSpy",
      description: "The requested VoxelSpy page was not found.",
    }
  );
}

export function routeMetadata(path: string) {
  return resolveMetadata(path);
}

function applyTheme(preference: ThemePreference) {
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
  if (preference === "system") localStorage.removeItem("voxelspy-theme");
  else localStorage.setItem("voxelspy-theme", preference);
}

function ThemeButton() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  useEffect(() => {
    const initial = document.documentElement.dataset.themePreference;
    if (initial === "system" || initial === "light" || initial === "dark")
      setPreference(initial);
  }, []);
  const next: Record<ThemePreference, ThemePreference> = {
    system: "light",
    light: "dark",
    dark: "system",
  };
  return (
    <button
      className="theme-button"
      type="button"
      onClick={() => {
        const value = next[preference];
        setPreference(value);
        applyTheme(value);
      }}
      aria-label={`Theme: ${preference}. Change to ${next[preference]}.`}
    >
      <span aria-hidden="true">
        {preference === "dark"
          ? "Moon"
          : preference === "light"
            ? "Sun"
            : "Auto"}
      </span>
    </button>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="brand-link" to="/" aria-label="VoxelSpy home">
          <Wordmark />
        </Link>
        <nav
          className={open ? "main-nav is-open" : "main-nav"}
          aria-label="Primary navigation"
        >
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/compare/">Compare</NavLink>
          <NavLink to="/docs/">Docs</NavLink>
        </nav>
        <div className="header-actions">
          <ThemeButton />
          <button
            className="menu-button"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            Menu
          </button>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="shell footer-inner">
        <Wordmark />
        <p>Compare geometry without giving it away.</p>
        <nav aria-label="Footer navigation">
          <Link to="/docs/privacy/">Privacy</Link>
          <Link to="/docs/geometry/">Geometry</Link>
        </nav>
      </div>
    </footer>
  );
}

function HomePage() {
  return (
    <>
      <section className="hero shell">
        <div>
          <span className="eyebrow">
            <i className="pulse" /> Browser-local by default
          </span>
          <h1>
            See what changed.<span> Keep the model.</span>
          </h1>
          <p className="lede">
            Compare 3D revisions, inspect meaningful geometric changes, and
            create portable results without making source models someone else's
            data.
          </p>
          <div className="actions">
            <Link className="button button-primary" to="/compare/">
              Start a comparison
            </Link>
            <Link
              className="button button-secondary"
              to="/docs/getting-started/"
            >
              Read the guide
            </Link>
          </div>
          <ul className="trust-row" aria-label="Product properties">
            <li>Local files</li>
            <li>Explicit units</li>
            <li>Inspectible methods</li>
          </ul>
        </div>
        <div
          className="hero-graphic"
          aria-label="Abstract baseline and candidate model comparison"
        >
          <div className="model-plane model-plane-a" />
          <div className="model-plane model-plane-b" />
          <div className="change-pip pip-one" />
          <div className="change-pip pip-two" />
          <div className="graphic-key">
            <span>Baseline</span>
            <span>Candidate</span>
            <strong>Local comparison</strong>
          </div>
        </div>
      </section>
      <section className="section shell" aria-labelledby="principles-title">
        <header className="section-heading">
          <span className="eyebrow">Designed for scrutiny</span>
          <h2 id="principles-title">A result you can reason about</h2>
        </header>
        <div className="card-grid">
          <article>
            <span>01</span>
            <h3>Meaning stays intact</h3>
            <p>
              Units, transforms, warnings, provenance, and uncertainty stay
              visible. Corrections are explicit.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Methods fit the input</h3>
            <p>
              Every analysis method states its preconditions and whether its
              answer is exact, approximate, or indeterminate.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Sharing is separate</h3>
            <p>
              Normal comparison remains local. A portable artifact exists only
              when you deliberately create one.
            </p>
          </article>
        </div>
      </section>
    </>
  );
}

function SearchBox() {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchDocs(query), [query]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLocaleLowerCase("en-US") === "k"
      ) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  return (
    <div className="search-box">
      <label htmlFor="docs-search">
        Search documentation <kbd>Ctrl K</kbd>
      </label>
      <input
        ref={input}
        id="docs-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Try “units” or “privacy”"
      />
      {query && (
        <div className="search-results" aria-live="polite">
          {results.length ? (
            results.map((doc) => (
              <Link key={doc.path} to={doc.path}>
                <strong>{doc.title}</strong>
                <span>{doc.description}</span>
              </Link>
            ))
          ) : (
            <p>No documentation matched “{query}”.</p>
          )}
        </div>
      )}
    </div>
  );
}

function DocsNav() {
  return (
    <nav className="docs-nav" aria-label="Documentation">
      <NavLink to="/docs/" end>
        Overview
      </NavLink>
      {docs.map((doc) => (
        <NavLink key={doc.path} to={doc.path}>
          {doc.title}
        </NavLink>
      ))}
    </nav>
  );
}

function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-layout shell">
      <aside>
        <DocsNav />
      </aside>
      <div>{children}</div>
    </div>
  );
}

function DocsIndex() {
  return (
    <DocsLayout>
      <header className="page-hero docs-hero">
        <span className="eyebrow">Documentation</span>
        <h1>Know what the result means</h1>
        <p>
          Start with the local workflow, then inspect the privacy and geometry
          boundaries behind a trustworthy comparison.
        </p>
        <SearchBox />
      </header>
      <div className="docs-grid">
        {docs.map((doc) => (
          <Link key={doc.path} to={doc.path}>
            <span className="eyebrow">{doc.eyebrow}</span>
            <h2>{doc.title}</h2>
            <p>{doc.description}</p>
            <strong>Read guide →</strong>
          </Link>
        ))}
      </div>
    </DocsLayout>
  );
}

function DocArticle({ doc }: { doc: DocPage }) {
  return (
    <DocsLayout>
      <article className="doc-article">
        <header>
          <span className="eyebrow">{doc.eyebrow}</span>
          <h1>{doc.title}</h1>
          <p>{doc.description}</p>
        </header>
        {doc.sections.map((section) => (
          <section key={section.id} id={section.id}>
            <h2>{section.title}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </article>
    </DocsLayout>
  );
}

function NotFound() {
  return (
    <div className="page shell not-found">
      <span className="eyebrow">404</span>
      <h1>That route is not in this model.</h1>
      <p>Return to comparison or browse the documentation.</p>
      <div className="actions">
        <Link className="button button-primary" to="/compare/">
          Compare models
        </Link>
        <Link className="button button-secondary" to="/docs/">
          Browse docs
        </Link>
      </div>
    </div>
  );
}

function RouteEffects() {
  const location = useLocation();
  useEffect(() => {
    const current = resolveMetadata(location.pathname);
    document.title = current.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", current.description);
    if (location.hash)
      requestAnimationFrame(() =>
        document
          .getElementById(decodeURIComponent(location.hash.slice(1)))
          ?.scrollIntoView(),
      );
  }, [location.hash, location.pathname]);
  return null;
}

export function App() {
  return (
    <>
      <RouteEffects />
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <Header />
      <main id="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/compare/" element={<ComparisonFlow />} />
          <Route path="/docs/" element={<DocsIndex />} />
          {docs.map((doc) => (
            <Route
              key={doc.path}
              path={doc.path}
              element={<DocArticle doc={doc} />}
            />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
