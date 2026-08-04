import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { App, routeMetadata } from "./App";
import "./styles.css";

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
