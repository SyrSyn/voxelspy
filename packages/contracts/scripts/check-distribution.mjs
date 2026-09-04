import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "voxelspy-contracts-"));
const offlineEnvironment = {
  ...process.env,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
};

function run(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: offlineEnvironment,
    ...options,
  });
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat();
}

try {
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const runtimeDependencies = Object.keys(
    packageJson.dependencies ?? {},
  ).sort();
  if (
    runtimeDependencies.length !== 1 ||
    runtimeDependencies[0] !== "zod" ||
    packageJson.optionalDependencies !== undefined ||
    packageJson.peerDependencies !== undefined
  )
    throw new Error(
      `Unexpected package runtime dependencies: ${runtimeDependencies.join(",") || "none"}`,
    );
  const packageText = `${JSON.stringify(packageJson)}\n${await readFile(
    join(packageRoot, "README.md"),
    "utf8",
  )}`;
  if (packageText.includes(repositoryRoot))
    throw new Error("Package metadata contains a local repository path");
  const packOutput = run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
    { cwd: packageRoot },
  );
  const packed = JSON.parse(packOutput)[0];
  if (
    !packed ||
    typeof packed.filename !== "string" ||
    !Array.isArray(packed.files)
  )
    throw new TypeError("Package manager returned invalid pack metadata");

  const expectedFiles = new Set(["README.md", "package.json"]);
  for (const target of Object.values(packageJson.exports)) {
    for (const key of ["types", "import"]) {
      const path = target[key]?.replace(/^\.\//u, "");
      if (path) expectedFiles.add(path);
      if (key === "types" && path) expectedFiles.add(`${path}.map`);
    }
  }
  const packedFiles = new Set(packed.files.map(({ path }) => path));
  const unexpected = [...packedFiles].filter(
    (path) => !expectedFiles.has(path),
  );
  const missing = [...expectedFiles].filter((path) => !packedFiles.has(path));
  if (unexpected.length > 0 || missing.length > 0)
    throw new Error(
      `Unexpected package contents; extra=${unexpected.join(",") || "none"}; missing=${missing.join(",") || "none"}`,
    );

  const forbiddenIdentifiers = new Set([
    "Blob",
    "Buffer",
    "Document",
    "File",
    "HTMLElement",
    "MessageEvent",
    "MessagePort",
    "NodeJS",
    "Transferable",
    "Window",
    "Worker",
    "fetch",
    "localStorage",
    "process",
    "require",
  ]);
  for (const path of await filesBelow(join(packageRoot, "dist"))) {
    if (!/\.(?:js|d\.ts)$/u.test(path)) continue;
    const source = await readFile(path, "utf8");
    if (source.includes(repositoryRoot))
      throw new Error(
        `Private build text in ${relative(repositoryRoot, path)}`,
      );
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const inspect = (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /^(?:node:|react(?:\/|$)|three(?:\/|$))/u.test(
          node.moduleSpecifier.text,
        )
      )
        throw new Error(
          `Forbidden dependency in ${relative(repositoryRoot, path)}: ${node.moduleSpecifier.text}`,
        );
      if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text))
        throw new Error(
          `Forbidden runtime identifier in ${relative(repositoryRoot, path)}: ${node.text}`,
        );
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
  }

  await writeFile(
    join(temporaryRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@voxelspy/contracts": `file:${join(temporaryRoot, packed.filename)}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm CLI path is unavailable");
  // Installing the packed archive needs this package's own dependencies
  // resolved. Prefer the local mirror so the check stays hermetic and quick,
  // but fall back to a normal resolve when that mirror has no metadata for
  // them: a continuous-integration runner caches the content store while a
  // lockfile-frozen install never populates the metadata mirror, so offline
  // resolution fails there for reasons that say nothing about the archive
  // under test.
  const installArguments = [
    "install",
    "--ignore-scripts",
    "--no-frozen-lockfile",
  ];
  try {
    run(process.execPath, [pnpmCli, ...installArguments, "--offline"], {
      cwd: temporaryRoot,
    });
  } catch (offlineFailure) {
    const detail = String(offlineFailure?.stdout ?? offlineFailure);
    if (!detail.includes("ERR_PNPM_NO_OFFLINE_META")) throw offlineFailure;
    process.stdout.write(
      "Local mirror lacks metadata for this package's dependencies; resolving them normally.\n",
    );
    run(process.execPath, [pnpmCli, ...installArguments], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    });
  }

  await writeFile(
    join(temporaryRoot, "node-entry.mjs"),
    await readFile(
      join(packageRoot, "test/consumers/distribution/node-entry.mjs"),
      "utf8",
    ),
  );
  const nodeOutput = run(
    process.execPath,
    [join(temporaryRoot, "node-entry.mjs")],
    {
      cwd: temporaryRoot,
    },
  );
  if (!nodeOutput.includes("installed-node-consumer:ok"))
    throw new Error("Installed Node consumer did not complete");

  await writeFile(
    join(temporaryRoot, "browser-entry.mjs"),
    await readFile(
      join(packageRoot, "test/consumers/distribution/browser-entry.mjs"),
      "utf8",
    ),
  );
  const browserOutput = join(temporaryRoot, "browser-output");
  await mkdir(browserOutput);
  await build({
    absWorkingDir: temporaryRoot,
    bundle: true,
    entryPoints: ["browser-entry.mjs"],
    format: "esm",
    logLevel: "silent",
    outfile: join(browserOutput, "browser-bundle.mjs"),
    platform: "browser",
    target: "es2022",
  });
  const browserModule = await import(
    `${pathToFileURL(join(browserOutput, "browser-bundle.mjs")).href}?check=1`
  );
  if (browserModule.browserContractCheck !== true)
    throw new Error("Browser-target bundle did not execute its schema checks");
  console.log(
    "distribution-consumers: tarball, Node ESM, browser bundle, and public boundaries passed",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
