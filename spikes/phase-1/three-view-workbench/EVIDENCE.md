# Evidence record

This spike was exercised as a production build in headless Chromium at representative desktop (1440 × 1000), tablet (810 × 1080), and mobile (390 × 844) viewports.

## Observed behavior

- A wheel zoom in the difference viewport changes the renderer-observed camera in all three canvases, converges on identical camera values, and remains stable after interaction without a feedback loop.
- Ranked-region selection and keyboard stepping update the selected-location label in baseline, candidate, and difference views.
- Framing changes the renderer-observed camera target and pose, and cross-section changes create matching material clipping planes in all three rendering scenes.
- Tablet and mobile layouts keep the difference view largest, retain baseline and candidate context, remove the closed findings panel from focus and accessibility navigation, restore focus at its heading when opened, and avoid horizontal document overflow.
- Dark, light, and high-contrast themes render. Difference semantics pair color with solid, hatched, and ring cues.
- The reduced-motion media preference suppresses animation duration. The tested page made no requests outside its local origin.
- A Chromium run with WebGL and GPU support disabled renders three accessible unsupported-state messages without canvases, console errors, or uncaught page errors; ranked findings and controls remain readable.

The automated suite does not prove physical-device gesture feel, screen-reader announcements across browser and assistive-technology combinations, visual correctness on graphics drivers outside headless Chromium, or algorithmic geometry correctness. Those remain product-level validation work rather than claims of this interaction spike.

## Performance and dependency notes

The production JavaScript is about 1.09 MB minified and 302 kB compressed. This is acceptable evidence overhead for an isolated Three.js prototype, but a product integration should lazy-load or split the 3D workbench. Rendering is demand-driven, device pixel ratio is capped, shadows are disabled, and geometry buffers remain outside shared React state.

All direct runtime packages report the MIT license. The prototype depends on React, Three.js, React Three Fiber, Drei, and three-stdlib; transitive packages and any promotion should still go through the repository's normal dependency review and lock-version policy.
