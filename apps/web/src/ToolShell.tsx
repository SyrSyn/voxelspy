import type { ReactNode } from "react";

export interface ToolShellProps {
  /** Short category label above the heading (e.g. "Tools", "Compare"). */
  eyebrow: string;
  title: string;
  /** One-line description, rendered directly under the heading. */
  description: string;
  /** Optional actions rendered under the description (buttons/links). */
  actions?: ReactNode;
  /** The tool's own UI. */
  children: ReactNode;
}

/**
 * Shared page shell for a tool page: a heading, a one-line description, and
 * a slot for the tool's own UI, with the same spacing and heading structure
 * every other top-level page in this app uses (`.page.shell` +
 * `.page-hero`). Purely presentational -- it holds no geometry logic and
 * knows nothing about any particular tool's data, so both the tools catalog
 * (`/tools/`) and a future individual tool page (e.g. `/tools/inspect/`)
 * can wrap themselves in it.
 */
export function ToolShell({
  eyebrow,
  title,
  description,
  actions,
  children,
}: ToolShellProps) {
  return (
    <div className="page shell tool-shell">
      <header className="page-hero">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
        {actions ? <div className="actions">{actions}</div> : null}
      </header>
      <section className="tool-shell-body" aria-label={`${title} workspace`}>
        {children}
      </section>
    </div>
  );
}
