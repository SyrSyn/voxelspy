# Physical-device acceptance

Automated browser emulation is recorded separately from physical-device results.
Use synthetic or redistribution-cleared models. Run against the same qualified
build and record its revision, browser version, device, operating system and
whether hardware graphics acceleration is enabled.

## Suggested coverage

| Device                             | Useful coverage                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| iPhone 13, Safari                  | Touch selection, camera gestures, file picker, downloads and session reopen; WebKit memory and worker recovery |
| Older Android phone, Chrome        | Bounded imports, cancellation, memory pressure, responsive controls and recovery after backgrounding           |
| Newer Android phone, Chrome        | Touch interaction, larger model rendering, downloads and portrait/landscape changes                            |
| Windows laptop, Edge and Firefox   | File handling, keyboard navigation, WebGL driver differences, report/session download and reopen               |
| Linux laptop, Chromium and Firefox | Keyboard and graphics coverage on another operating system; high-DPI and external-display layouts              |

One older and one newer Android are sufficient for the initial pass. Record the
models and available memory; additional phones are useful when they add a
meaningfully different browser, GPU or memory budget.

## Required journeys

1. Open Inspect, load the small original fixture, check declared units and
   dimensions, then download and inspect the evidence JSON.
2. Compare two fixtures, select a changed region, rotate and zoom with touch or
   keyboard, create a callout and distance measurement, and save a named view.
   Download the HTML report and portable session. Reopen the session and restore
   its saved view and annotations.
3. In Convert, preview original and simplified geometry, review the sampled
   deviation qualifications, download an export and reimport it with its stated
   frame. Confirm dimensions and visible geometry.
4. In Measure & Section, measure from `(0,0,0)` to `(3,4,0)` and expect
   5 mm. Section the 10 mm cube halfway along one axis: expect a closed square
   with 40 mm perimeter and 100 mm² area. Retain the evidence JSON.
5. In Clearance & Fit, compare the cube with the supplied separated cube:
   expect a 5 mm gap. Change the requested clearance from 4 mm to 6 mm and
   confirm the reported condition changes from Clear to Tight.
6. In Printability, use a 9 × 9 × 9 mm build volume for the 10 mm cube and
   confirm that it does not fit. Check that thickness and overhang results keep
   their sampling qualifications visible and can be downloaded.
7. In File Forensics, confirm a fixture's digest against `SHA256SUMS`, inspect
   the source frame and warnings, and download its evidence.
8. Run Mesh Health on a known crossing fixture; confirm reported source triangle
   locations. Load a degenerate fixture and confirm uncertainty remains visible.
9. Import a small STEP fixture. Confirm source units, declared up-axis,
   tessellation settings and warnings. Cancel a larger operation and verify that
   a later small import succeeds.
10. Background and foreground the browser during an operation, rotate the phone,
    change theme, and deny storage access where the browser supports it. Confirm
    readable results and reachable controls after recovery.
11. Navigate primary controls using the keyboard on laptops. On phones, verify
    every action can be reached without horizontal page overflow; intentional
    table scrollers may scroll within their own bounds.
12. For the integrated local PDM installation, sign in through the captured
    inbox, create a workspace and upload synthetic revisions, including STEP.
    Open all eight project tools and explicitly save their outputs. Author a
    callout, distance and named camera view; save, reload and reopen that exact
    session. Confirm source bindings, comments and converted export frames.
    Verify a Viewer can use local tools but cannot save or comment, and that
    revoked access clears the workbench. Confirm another private workspace
    cannot read the first workspace's sources or artifacts.

Record failures with the smallest fixture and reproduction steps. Record elapsed
interaction times where useful, but do not infer a universal performance promise
from one device. Physical tests remain pending until an operator records actual
results; no physical-device pass is claimed by this checklist.
