/** Original procedural ISO-10303-21 fixture, MIT under the repository license.
 * Written for VoxelSpy; no upstream CAD data or proprietary tool output.
 * Independent oracle: offset cuboid [5,7,11] -> [15,27,41] in source units.
 */
export function cuboidStep(
  options: {
    unit?: "millimetre" | "metre" | "inch";
    origin?: readonly [number, number, number];
  } = {},
): string {
  const lines: string[] = [];
  const add = (value: string) => {
    const id = lines.length + 1;
    lines.push(`#${id}=${value};`);
    return `#${id}`;
  };
  const app = add(
    "APPLICATION_CONTEXT('configuration controlled 3d designs of mechanical parts and assemblies')",
  );
  add(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,${app})`,
  );
  const productContext = add(`PRODUCT_CONTEXT('',${app},'mechanical')`);
  const product = add(
    `PRODUCT('fixture','Original offset cuboid','',(${productContext}))`,
  );
  const formation = add(
    `PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',${product},.NOT_KNOWN.)`,
  );
  const definitionContext = add(
    `PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`,
  );
  const definition = add(
    `PRODUCT_DEFINITION('design','',${formation},${definitionContext})`,
  );
  const shape = add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
  const mm = add("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))");
  const length =
    options.unit === "metre"
      ? add("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.))")
      : options.unit === "inch"
        ? add(
            `(CONVERSION_BASED_UNIT('INCH',${add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),${mm})`)}) LENGTH_UNIT() NAMED_UNIT(*))`,
          )
        : mm;
  const angle = add("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))");
  const solidAngle = add(
    "(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())",
  );
  const tolerance = add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-7),${length},'distance_accuracy_value','')`,
  );
  const context = add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${tolerance})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle})) REPRESENTATION_CONTEXT('',''))`,
  );
  const origin = options.origin ?? [5, 7, 11];
  const point = (p: readonly number[]) =>
    add(`CARTESIAN_POINT('',(${p.map((v) => `${v}.`).join(",")}))`);
  const points = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 20, 0],
    [0, 20, 0],
    [0, 0, 30],
    [10, 0, 30],
    [10, 20, 30],
    [0, 20, 30],
  ].map((p) => point(p.map((v, i) => v + origin[i]!)));
  const direction = (p: readonly number[]) =>
    add(`DIRECTION('',(${p.map((v) => `${v}.`).join(",")}))`);
  const axis = (
    p: string,
    normal: readonly number[],
    reference: readonly number[],
  ) =>
    add(
      `AXIS2_PLACEMENT_3D('',${p},${direction(normal)},${direction(reference)})`,
    );
  const faces = [
    { corners: [0, 3, 2, 1], normal: [0, 0, -1], ref: [1, 0, 0] },
    { corners: [4, 5, 6, 7], normal: [0, 0, 1], ref: [1, 0, 0] },
    { corners: [0, 1, 5, 4], normal: [0, -1, 0], ref: [1, 0, 0] },
    { corners: [1, 2, 6, 5], normal: [1, 0, 0], ref: [0, 1, 0] },
    { corners: [2, 3, 7, 6], normal: [0, 1, 0], ref: [-1, 0, 0] },
    { corners: [3, 0, 4, 7], normal: [-1, 0, 0], ref: [0, -1, 0] },
  ].map((face) => {
    const loop = add(
      `POLY_LOOP('',(${face.corners.map((i) => points[i]).join(",")}))`,
    );
    const bound = add(`FACE_OUTER_BOUND('',${loop},.T.)`);
    const plane = add(
      `PLANE('',${axis(points[face.corners[0]!]!, face.normal, face.ref)})`,
    );
    return add(`FACE_SURFACE('',(${bound}),${plane},.T.)`);
  });
  const shell = add(`CLOSED_SHELL('',(${faces.join(",")}))`);
  const solid = add(`FACETED_BREP('Original offset cuboid',${shell})`);
  const placement = axis(point([0, 0, 0]), [0, 0, 1], [1, 0, 0]);
  const representation = add(
    `FACETED_BREP_SHAPE_REPRESENTATION('',(${placement},${solid}),${context})`,
  );
  add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Original procedural cuboid'),'2;1');\nFILE_NAME('original-cuboid.step','2000-01-01T00:00:00',('VoxelSpy contributors'),('VoxelSpy'),'VoxelSpy fixture','VoxelSpy','');\nFILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));\nENDSEC;\nDATA;\n${lines.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`;
}
