import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { App, routeMetadata } from "./App";
import { routes } from "./content";
import "./styles.css";

/** Route list for the prerenderer and static verifier, so the site cannot
 *  declare a page the build never emits. */
export { routes };

export function render(url: string) {
  return {
    html: renderToString(
      <StaticRouter location={url}>
        <App />
      </StaticRouter>,
    ),
    metadata: routeMetadata(url),
  };
}
