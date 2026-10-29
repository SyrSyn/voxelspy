# Reproduce the sleeve comparison

These two ASCII STL models are original synthetic demo geometry, distributed
under the repository [MIT license](../../LICENSE). No third-party CAD or
customer data was used. They are examples for software evaluation, not designs
qualified for fabrication.

Download the raw files, then choose them in **Compare** with millimetres and
right-handed Z-up. Use a 0.1 mm tolerance:

- [Baseline revision A](mounting-sleeve-rev-a.stl): height 28 mm, body radius 15 mm.
- [Candidate revision B](mounting-sleeve-rev-b.stl): height 33 mm, body radius 17 mm.

Both have a 23 mm flange radius, 5 mm flange thickness and 10 mm bore radius.
The closed surfaces use 96 radial segments and 1,152 triangles each. Inspect
revision B to reproduce the 46 × 46 × 33 mm bounds shown in the README.
STL contains no authoritative unit or axis declaration: the millimetre/Z-up
interpretation is supplied by you.

Regenerate the checked-in files from the repository root using Node.js:

```sh
node docs/examples/generate.mjs
```

The generator writes only these two named files beside itself, deterministically.
Its facet normal fields are zero; the importer derives geometry from vertex
winding. Reported volume and sampled differences describe these polygonal
meshes, rather than an analytic cylindrical CAD model. Read the result's
warnings and sample-spacing bounds when interpreting differences.
