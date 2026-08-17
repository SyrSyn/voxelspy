import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { Wordmark } from "./Brand";
import { ComparisonFlow } from "./ComparisonFlow";
import { HomeDemo } from "./HomeDemo";
import { docs, searchDocs, type DocPage } from "./content";

type ThemePreference = "system" | "light" | "dark";

const baseMetadata = {
  "/": {
    title: "VoxelSpy — A 3D Toolkit, Free Forever",
    description:
      "Explore a loaded sample revision with synchronized difference, baseline, and candidate views.",
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
  const icon = {
    system: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
    light: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
      </svg>
    ),
    dark: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.4 15.4A8.5 8.5 0 0 1 8.6 3.6 8.5 8.5 0 1 0 20.4 15.4Z" />
      </svg>
    ),
  } satisfies Record<ThemePreference, React.ReactNode>;
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
      title={`Theme: ${preference}`}
    >
      {icon[preference]}
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
          <span className="brand-lockup">
            <Wordmark markSize={40} />
            <span className="brand-tagline" aria-hidden="true">
              Instant - Local - Open Source
            </span>
          </span>
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
          <a
            className="github-link"
            href="https://github.com/SyrSyn/voxelspy"
            target="_blank"
            rel="noreferrer"
            aria-label="VoxelSpy on GitHub"
          >
            <span className="github-label">GitHub</span>
          </a>
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
  return <HomeDemo />;
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
