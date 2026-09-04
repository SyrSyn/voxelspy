import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Runtime WebGL availability, probed inside the real page rather than
 * assumed from the project name. Mirrors `capability.ts`'s own
 * `probeWebGLAvailability`, which the app calls at render time to decide
 * between a live `<canvas>` and the accessible `.render-fallback` --
 * `role="status"` -- markup (see `Workbench.tsx`'s `View`,
 * `MeshHealthViewer.tsx`, `ClearanceViewer.tsx`, `PrintabilityViewer.tsx`,
 * and `MeasureSectionViewer.tsx`, which all share that fallback shape).
 *
 * This exists because headless Firefox in CI has no GPU/WebGL context at
 * all (`canvas.getContext("webgl2"|"webgl")` returns `null`), which is a
 * genuine, permanent property of that environment, not a regression --
 * the app was built and unit-tested to degrade to the fallback exactly for
 * this case. Chromium and WebKit are expected to have real WebGL in every
 * project this suite runs (desktop and mobile), so a canvas-count
 * regression on either of those still fails the assertions built on top of
 * this probe.
 */
export async function isWebGLAvailable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      context?.getExtension("WEBGL_lose_context")?.loseContext();
      return context !== null;
    } catch {
      return false;
    }
  });
}

/**
 * Asserts that exactly `count` 3D viewports inside `container` rendered as
 * this browser's actual WebGL capability dictates: real `<canvas>` elements
 * when a context is available, or the app's `.render-fallback` elements
 * when it is not. Returns which branch applied so callers can layer
 * WebGL-only evidence (accessible names, context-health checks, ...) on top
 * only when it is meaningful, without weakening the assertion on engines
 * that do have WebGL.
 */
export async function expectViewportsRendered(
  page: Page,
  container: Locator,
  count: number,
  options?: { timeout?: number },
): Promise<boolean> {
  const webglAvailable = await isWebGLAvailable(page);
  if (webglAvailable) {
    await expect(container.locator("canvas")).toHaveCount(count, options);
  } else {
    await expect(container.locator(".render-fallback")).toHaveCount(
      count,
      options,
    );
  }
  return webglAvailable;
}
