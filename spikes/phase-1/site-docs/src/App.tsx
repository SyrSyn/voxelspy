import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { VoxelMark, Wordmark } from "./Brand";
import { docs, searchableDocs, type DocPage } from "./content";

type ThemePreference = "system" | "light" | "dark";

const metadata: Record<string, { title: string; description: string }> = {
  "/": {
    title: "VoxelSpy — Compare 3D models privately",
    description:
      "Inspect revisions, find geometric differences, and keep normal 3D model comparison on your device.",
  },
  "/tools/": {
    title: "Tools — VoxelSpy",
    description:
      "Start a private 3D model comparison and inspect the local-first tool boundary.",
  },
  "/docs/": {
    title: "Documentation — VoxelSpy",
    description:
      "Learn how VoxelSpy handles local comparison, geometry correctness, privacy, and portable results.",
  },
};

function applyTheme(preference: ThemePreference) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolved =
    preference === "system" ? (media.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
  if (preference === "system") localStorage.removeItem("voxelspy-theme");
  else localStorage.setItem("voxelspy-theme", preference);
}

function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    const saved = document.documentElement.dataset.themePreference;
    if (saved === "light" || saved === "dark" || saved === "system")
      setPreference(saved);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (document.documentElement.dataset.themePreference === "system")
        applyTheme("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const choices: ThemePreference[] = ["system", "light", "dark"];
  const next = choices[(choices.indexOf(preference) + 1) % choices.length];

  return (
    <button
      className="icon-button theme-control"
      type="button"
      onClick={() => {
        setPreference(next);
        applyTheme(next);
      }}
      aria-label={`Theme: ${preference}. Change to ${next}.`}
      title={`Theme: ${preference}`}
    >
      <span aria-hidden="true">
        {preference === "system" ? "◐" : preference === "light" ? "☼" : "☾"}
      </span>
      <span className="theme-control__label">{preference}</span>
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
          <Wordmark size={32} />
        </Link>
        <nav
          id="main-navigation"
          className={open ? "main-nav is-open" : "main-nav"}
          aria-label="Primary navigation"
        >
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/tools/">Tools</NavLink>
          <NavLink to="/docs/">Docs</NavLink>
        </nav>
        <div className="header-actions">
          <ThemeControl />
          <button
            className="icon-button menu-button"
            type="button"
            aria-expanded={open}
            aria-controls="main-navigation"
            onClick={() => setOpen(!open)}
          >
            <span aria-hidden="true">{open ? "×" : "≡"}</span>
            <span className="sr-only">Menu</span>
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
        <Wordmark size={28} />
        <p>Compare geometry without giving it away.</p>
        <nav aria-label="Footer navigation">
          <Link to="/docs/privacy/">Privacy</Link>
          <Link to="/docs/geometry-contract/">Geometry contract</Link>
        </nav>
      </div>
    </footer>
  );
}

function FilePicker({
  label,
  id,
  onFile,
}: {
  label: string;
  id: string;
  onFile: (name: string) => void;
}) {
  const [fileName, setFileName] = useState("");
  return (
    <label className="file-picker" htmlFor={id}>
      <span className="file-picker__label">{label}</span>
      <span className="file-picker__name">
        {fileName || "Choose a model from this device"}
      </span>
      <input
        id={id}
        type="file"
        accept=".stl,.obj,.ply,.glb,.gltf,.3mf"
        onChange={(event) => {
          const name = event.currentTarget.files?.[0]?.name ?? "";
          setFileName(name);
          onFile(name);
        }}
      />
      <span className="button button--secondary" aria-hidden="true">
        Browse
      </span>
    </label>
  );
}

function ComparisonStarter({ compact = false }: { compact?: boolean }) {
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const ready = Boolean(baseline && candidate);
  return (
    <section
      className={
        compact
          ? "comparison-starter comparison-starter--compact"
          : "comparison-starter"
      }
      aria-labelledby="starter-title"
    >
      <div className="section-heading">
        <span className="eyebrow">Local comparison</span>
        <h2 id="starter-title">Choose two models</h2>
        <p>
          Files selected here stay on this device. This prototype validates file
          selection and the product boundary; geometry analysis is not connected
          yet.
        </p>
      </div>
      <div className="picker-grid">
        <FilePicker
          label="Baseline model"
          id={compact ? "tool-baseline" : "home-baseline"}
          onFile={setBaseline}
        />
        <FilePicker
          label="Candidate model"
          id={compact ? "tool-candidate" : "home-candidate"}
          onFile={setCandidate}
        />
      </div>
      <div className="starter-footer" aria-live="polite">
        <span className={ready ? "status status--ready" : "status"}>
          <span aria-hidden="true" />
          {ready ? "Both models ready" : "Waiting for two local files"}
        </span>
        <button
          className="button button--primary"
          type="button"
          disabled={!ready}
          title={
            ready
              ? "Analysis engine not connected in this prototype"
              : "Choose two models first"
          }
        >
          Prepare comparison
        </button>
      </div>
    </section>
  );
}

function ModelDiagram() {
  return (
    <div
      className="model-diagram"
      aria-label="Abstract diagram of two overlapping voxel models"
    >
      <div className="model-grid" aria-hidden="true">
        {Array.from({ length: 25 }, (_, index) => (
          <span
            key={index}
            className={
              index % 4 === 0 || index === 12 ? "voxel voxel--active" : "voxel"
            }
          />
        ))}
      </div>
      <div className="model-grid model-grid--candidate" aria-hidden="true">
        {Array.from({ length: 25 }, (_, index) => (
          <span
            key={index}
            className={
              index % 6 === 0 || index === 13 ? "voxel voxel--active" : "voxel"
            }
          />
        ))}
      </div>
      <div className="diagram-caption">
        <span>Baseline</span>
        <span>Candidate</span>
        <strong>7 changes</strong>
      </div>
    </div>
  );
}

function HomePage() {
  return (
    <>
      <section className="hero shell">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="pulse" /> Private by default
          </span>
          <h1>
            See what changed.
            <br />
            <span>Keep the model.</span>
          </h1>
          <p className="hero-lede">
            Compare 3D model revisions in your browser, inspect meaningful
            geometric differences, and share only the result you intend to
            share.
          </p>
          <div className="hero-actions">
            <a className="button button--primary" href="#compare">
              Compare models
            </a>
            <Link
              className="button button--secondary"
              to="/docs/getting-started/"
            >
              Read the guide
            </Link>
          </div>
          <ul className="trust-row" aria-label="Product properties">
            <li>Local-first</li>
            <li>Explicit units</li>
            <li>Portable results</li>
          </ul>
        </div>
        <ModelDiagram />
      </section>
      <div className="shell" id="compare">
        <ComparisonStarter />
      </div>
      <section className="principles shell" aria-labelledby="principles-title">
        <div className="section-heading">
          <span className="eyebrow">Designed for scrutiny</span>
          <h2 id="principles-title">Differences you can reason about</h2>
        </div>
        <div className="card-grid">
          <article className="info-card">
            <span className="card-index">01</span>
            <h3>Source meaning stays intact</h3>
            <p>
              Units, transforms, warnings, provenance, and uncertainty remain
              visible. No silent alignment or repair.
            </p>
          </article>
          <article className="info-card">
            <span className="card-index">02</span>
            <h3>Methods fit the question</h3>
            <p>
              Distance, voxel, and Boolean methods have different preconditions.
              The interface should make that choice inspectable.
            </p>
          </article>
          <article className="info-card">
            <span className="card-index">03</span>
            <h3>Sharing is a separate act</h3>
            <p>
              Normal comparison stays local. Portable reports and sessions begin
              only when you choose to create them.
            </p>
          </article>
        </div>
      </section>
    </>
  );
}

function ToolsPage() {
  return (
    <div className="page shell">
      <header className="page-hero">
        <span className="eyebrow">Tools</span>
        <h1>Start with the models</h1>
        <p>
          Select a baseline and candidate locally. The shell exposes where
          analysis will attach without implying that unfinished geometry work is
          available.
        </p>
      </header>
      <ComparisonStarter compact />
      <section className="tool-boundary" aria-labelledby="boundary-title">
        <div>
          <span className="eyebrow">Current boundary</span>
          <h2 id="boundary-title">What this shell proves</h2>
        </div>
        <ul className="check-list">
          <li>Local file inputs accept common model extensions.</li>
          <li>No model network request or telemetry is configured.</li>
          <li>
            The unfinished analysis action remains visible and clearly
            unavailable.
          </li>
        </ul>
      </section>
    </div>
  );
}

function SearchBox() {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return searchableDocs
      .filter((item) =>
        `${item.title} ${item.excerpt} ${item.keywords}`
          .toLowerCase()
          .includes(normalized),
      )
      .slice(0, 6);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="docs-search">
      <label htmlFor="docs-search">
        Search documentation <kbd>⌘ K</kbd>
      </label>
      <input
        ref={inputRef}
        id="docs-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Try “units” or “privacy”"
        autoComplete="off"
      />
      {query && (
        <div className="search-results" aria-live="polite">
          {results.length ? (
            results.map((result) => (
              <Link key={`${result.path}-${result.title}`} to={result.path}>
                <strong>{result.title}</strong>
                <span>{result.excerpt}</span>
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

function DocsNavigation() {
  return (
    <nav className="docs-nav" aria-label="Documentation">
      <Link to="/docs/">Overview</Link>
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
    <div className="docs-shell shell">
      <aside>
        <DocsNavigation />
      </aside>
      <div className="docs-main">{children}</div>
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
          contracts that make a comparison trustworthy.
        </p>
        <SearchBox />
      </header>
      <div className="docs-card-grid">
        {docs.map((doc) => (
          <Link className="doc-card" key={doc.path} to={doc.path}>
            <span>{doc.eyebrow}</span>
            <h2>{doc.title}</h2>
            <p>{doc.description}</p>
            <strong>
              Read guide <span aria-hidden="true">→</span>
            </strong>
          </Link>
        ))}
      </div>
    </DocsLayout>
  );
}

function BrandSpecimens() {
  return (
    <div className="brand-specimens" aria-label="Brand mark specimens">
      <div className="specimen specimen--dark">
        <Wordmark size={36} />
      </div>
      <div className="specimen specimen--light">
        <Wordmark size={36} />
      </div>
      <div className="specimen specimen--mono">
        <Wordmark size={36} monochrome />
      </div>
      <div className="specimen specimen--small">
        <VoxelMark size={16} label="VoxelSpy icon at 16 pixels" />
        <VoxelMark size={24} label="VoxelSpy icon at 24 pixels" />
        <VoxelMark size={32} label="VoxelSpy icon at 32 pixels" />
      </div>
    </div>
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
        {doc.path === "/docs/brand/" && <BrandSpecimens />}
        {doc.sections.map((section) => (
          <section key={section.id} id={section.id}>
            <h2>{section.title}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
        <nav className="article-next" aria-label="Documentation actions">
          <Link to="/docs/">All documentation</Link>
          <Link to="/tools/">
            Open tools <span aria-hidden="true">→</span>
          </Link>
        </nav>
      </article>
    </DocsLayout>
  );
}

function NotFound() {
  return (
    <div className="page shell not-found">
      <VoxelMark size={64} />
      <span className="eyebrow">404</span>
      <h1>That route is not in this model.</h1>
      <p>Return to the tools or browse the documentation.</p>
      <div>
        <Link className="button button--primary" to="/tools/">
          Open tools
        </Link>
        <Link className="button button--secondary" to="/docs/">
          Browse docs
        </Link>
      </div>
    </div>
  );
}

function MetadataController() {
  const location = useLocation();
  useEffect(() => {
    const doc = docs.find((item) => item.path === location.pathname);
    const current = doc
      ? { title: `${doc.title} — VoxelSpy Docs`, description: doc.description }
      : (metadata[location.pathname] ?? {
          title: "Page not found — VoxelSpy",
          description: "The requested VoxelSpy page was not found.",
        });
    document.title = current.title;
    for (const [selector, content] of [
      ['meta[name="description"]', current.description],
      ['meta[property="og:title"]', current.title],
      ['meta[property="og:description"]', current.description],
      ['meta[name="twitter:title"]', current.title],
      ['meta[name="twitter:description"]', current.description],
    ])
      document.querySelector(selector)?.setAttribute("content", content);
  }, [location.pathname]);
  return null;
}

function HashScroller() {
  const location = useLocation();

  useEffect(() => {
    if (!location.hash) return;
    const targetId = decodeURIComponent(location.hash.slice(1));
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.pathname]);

  return null;
}

export function routeMetadata(path: string) {
  const doc = docs.find((item) => item.path === path);
  return doc
    ? { title: `${doc.title} — VoxelSpy Docs`, description: doc.description }
    : (metadata[path] ?? {
        title: "Page not found — VoxelSpy",
        description: "The requested VoxelSpy page was not found.",
      });
}

export function App() {
  return (
    <>
      <MetadataController />
      <HashScroller />
      <div className="ambient ambient--one" aria-hidden="true" />
      <div className="ambient ambient--two" aria-hidden="true" />
      <Header />
      <main id="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/tools/" element={<ToolsPage />} />
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
