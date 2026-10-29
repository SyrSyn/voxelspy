# Use VoxelSpy

VoxelSpy helps you understand a mesh before you print, share, or review it.
The free tools process files on your device. No account or PDM installation is
required. The software is pre-release; use results as review evidence and
check critical dimensions independently.

## Start the free tools

From a checkout, install Node.js 24 and enable Corepack, then run:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@voxelspy/web
pnpm --filter @voxelspy/web dev
```

Open the URL printed by Vite, then choose **Tools**. Development mode is for
local development; use the Docker example or a configured static host to
exercise the shipped security headers.

For a local Docker evaluation, with Docker and Compose installed:

```sh
docker compose -f compose.example.yaml up --build -d
```

Open <http://localhost:8080>. Change the port with `VOXELSPY_PORT=8085` before
the command if needed. The image builds from your checkout; no published
VoxelSpy image is assumed. Stop it with:

```sh
docker compose -f compose.example.yaml down
```

This example serves only static files, has no persistent model storage, and
binds to loopback. Files stay in the browser unless you explicitly download
and share an output. HTTPS, public routing, access policy and operational
acceptance belong to your deployment. See [static hosting](../apps/web/DEPLOYMENT.md)
for the header, deep-link and privacy checks.

## Compare revisions

Try the included [baseline sleeve](examples/mounting-sleeve-rev-a.stl) and
[candidate sleeve](examples/mounting-sleeve-rev-b.stl): download both raw files,
use millimetres and Z-up, and compare at 0.1 mm tolerance. This is the original
synthetic pair shown in the README; see [example provenance](examples/README.md).

1. Open **Compare**, choose the baseline and candidate files, and check the
   resolved units and up-axis. STL/OBJ defaults are interpretations, not file
   declarations. STEP requires an explicit up-axis.
2. Set a tolerance in millimetres appropriate to your review. Keep models in
   their intended shared frame; comparison does not silently align them.
3. Run the comparison. Use synchronized views and ranked changed regions to
   investigate differences, then read warnings and the sample-spacing bound.
4. Add callouts, distance markups or named views to explain your review.
5. **Export report** downloads a self-contained HTML summary. **Save session**
   downloads a `.voxelspy` archive with both source models and review state.
   Reopen the archive in Compare to continue without repeating analysis.

A report contains findings and source metadata; a session also contains the
original model bytes. Treat shared outputs according to your data policy.
Sampled distances can miss small features and do not certify fit or geometric
identity, even when a result is within your chosen tolerance.

## Choose a tool

| Tool              | Useful first question                        | Workflow                                                                                      |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Compare           | What changed between revisions?              | Load two models, set tolerance, review regions and export a report/session.                   |
| Inspect           | What did this file import as?                | Load one model; inspect dimensions, topology, volume qualifications and provenance.           |
| Mesh Health       | Are there crossing or problematic triangles? | Run the bounded check; review located findings and indeterminate outcomes.                    |
| Measure & Section | What is this distance or cross-section?      | Pick geometry and a section plane; export evidence with its frame.                            |
| Clearance & Fit   | How close are these positioned parts?        | Load two parts in their intended frame; review sampled clearance and intersection evidence.   |
| Printability      | What should I investigate before printing?   | Check orientation/build-volume evidence and qualifications; validate in your slicer.          |
| File Forensics    | What is actually in this file?               | Inspect format declarations, importer warnings and rejected content.                          |
| Convert           | Can I hand off a mesh in another format?     | Choose output frame/format, preview changes and review any measured simplification deviation. |

All tools accept the supported bounded subsets of STL, OBJ, glTF/GLB, 3MF and
STEP. STEP is tessellated; analytic CAD and manufacturing semantics are not
preserved. Conversion supports STL, OBJ, glTF/GLB and 3MF, not STEP export.
See the [importer format limits](../packages/importers/README.md) before
planning a workflow around assemblies or large files.

## Automate an inspection

The CLI uses the same local engines. Build through the task runner first:

```sh
pnpm exec turbo run build --filter=@voxelspy/cli
node apps/cli/dist/cli.js inspect part.stl --unit millimetre --axis right-handed-z-up
node apps/cli/dist/cli.js compare baseline.stl candidate.stl \
  --baseline-unit millimetre --baseline-axis right-handed-z-up \
  --candidate-unit millimetre --candidate-axis right-handed-z-up \
  --tolerance 0.1
```

Replace those paths with your own files. Compare is informational unless you
select a failure policy. Read the [CLI guide](../apps/cli/README.md) for policy
flags, exit codes, JSON output, resource bounds and indeterminate results.
Packages are currently unpublished; do not assume an `npx voxelspy` release.

## Use the self-hosted suite

The separate [VoxelSpy PDM repository](https://github.com/SyrSyn/voxelspy-pdm)
adds private workspaces, revision uploads, reviews, comments and immutable
artifacts around the same tools. Access depends on that repository's
visibility. The free tools work independently.

In PDM, select project revisions, open a tool, create its output, then
explicitly save the staged artifact. Reopen a retained comparison session
against its exact revisions. A converted artifact remains an attachment until
you deliberately upload it as a new revision. Server-side permission checks
apply to source access and saving; a browser result remains client-submitted
evidence, not a server-certified manufacturing approval.

## If something looks wrong

- Check units and axes before changing geometry. Replacing a file resets
  expert overrides so they do not accidentally carry to a different model.
- Read importer warnings: supported file extensions do not imply support for
  every feature of the format.
- Lower workload or use a more capable device if a resource bound is reached.
  Raising a budget can exhaust a tab; it does not improve source quality.
- A WebGL fallback can still show textual evidence. Local analysis requires
  Web Workers; physical-device acceptance remains separate from emulation.
- For a reproducible issue, include format, tool, browser, relevant warnings
  and a redistributable synthetic example. Never post confidential models or
  credentials in an issue. See [security reporting](../SECURITY.md).
