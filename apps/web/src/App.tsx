import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { Wordmark } from "./Brand";
import { ComparisonFlow } from "./ComparisonFlow";
import { HomeDemo } from "./HomeDemo";
import { docs, searchDocs, tools, type DocPage } from "./content";
import { ToolShell } from "./ToolShell";

type ThemePreference = "system" | "light" | "dark";

const baseMetadata = {
  "/": {
    title: "VoxelSpy — A 3D Toolkit, Free Forever",
    description:
      "Explore a loaded sample revision with synchronized difference, baseline, and candidate views.",
  },
  "/tools/": {
    title: "Tools — VoxelSpy",
    description:
      "Browse the VoxelSpy toolbox: tools for understanding, validating, measuring, and comparing 3D geometry.",
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
          id="primary-navigation"
          className={open ? "main-nav is-open" : "main-nav"}
          aria-label="Primary navigation"
        >
          <NavLink to="/tools/">Tools</NavLink>
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
            aria-controls="primary-navigation"
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
        <p>Local tools for understanding geometry, without giving it away.</p>
        <nav aria-label="Footer navigation">
          <Link to="/tools/">Tools</Link>
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

function ToolCard({ tool }: { tool: (typeof tools)[number] }) {
  if (tool.status === "available")
    return (
      <Link className="tool-card tool-card-available" to={tool.path}>
        <span className="tool-status tool-status-available">
          <span aria-hidden="true">●</span> Available
        </span>
        <h2>{tool.name}</h2>
        <p>{tool.description}</p>
        <p className="tool-question">{tool.question}</p>
        <strong>Open tool →</strong>
      </Link>
    );
  return (
    <div className="tool-card tool-card-planned">
      <span className="tool-status tool-status-planned">
        <span aria-hidden="true">○</span> Planned — not built yet
      </span>
      <h2>{tool.name}</h2>
      <p>{tool.description}</p>
      <p className="tool-summary">{tool.summary}</p>
      <p className="tool-question">{tool.question}</p>
    </div>
  );
}

function ToolsIndex() {
  return (
    <ToolShell
      eyebrow="Tools"
      title="A toolbox for 3D geometry"
      description="Tools for understanding, validating, measuring, and comparing 3D geometry -- each one built to answer one question well, not to be another do-everything convert/view/repair site."
    >
      <div className="tools-grid">
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </div>
    </ToolShell>
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
        <p className="docs-tools-pointer">
          Looking for what VoxelSpy can do beyond comparison? See the{" "}
          <Link to="/tools/">tools catalog</Link>.
        </p>
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
      <p>Browse the toolbox or the documentation instead.</p>
      <div className="actions">
        <Link className="button button-primary" to="/tools/">
          Browse tools
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
  useEffect(() => {
    // The skip link in index.html (rendered outside this React root, so it
    // exists even before hydration) targets #main-content by fragment, but a
    // plain <main> is not natively focusable: activating the link would only
    // scroll, leaving focus on <body> instead of landing inside the page for
    // keyboard and screen-reader users. tabIndex is set imperatively here
    // (rather than as a JSX prop on <main> below) so it never appears in the
    // prerendered HTML that scripts/verify-static.mjs checks for an exact
    // `<main id="main-content">` match; it is applied after hydration, which
    // is what real keyboard interaction actually depends on.
    document.getElementById("main-content")?.setAttribute("tabindex", "-1");
  }, []);
  return (
    <>
      <RouteEffects />
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <Header />
      <main id="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/tools/" element={<ToolsIndex />} />
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
