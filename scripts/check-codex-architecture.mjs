import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-ast";

const root = fileURLToPath(new URL("../", import.meta.url));
export const codexSource = resolve(root, "pi-extensions");
const policyPath = resolve(root, "scripts/codex-architecture.json");

export function moduleReferences(text, filename = "module.ts") {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const references = [];
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) references.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )) {
      add(node.arguments[0]);
    } else if (ts.isExternalModuleReference(node)) {
      add(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(references)];
}

export function findCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];
  const visit = (file) => {
    if (visiting.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file]);
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of graph.keys()) visit(file);
  return cycles;
}

export function reachablePath(graph, start, matches) {
  const queue = [[start]];
  const seen = new Set([start]);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    for (const next of graph.get(path.at(-1)) ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (matches(next)) return nextPath;
      seen.add(next);
      queue.push(nextPath);
    }
  }
  return undefined;
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  }).sort();
}

export function checkArchitecture(directory, policy) {
  const files = policy.sourceRoots
    ? policy.sourceRoots.flatMap(path => sources(resolve(directory, path)))
    : sources(directory);
  const known = new Set(files);
  const graph = new Map();
  const errors = [];
  const measured = {};
  const packageRoots = policy.packageRoots ?? {};
  const manifests = new Map(Object.entries(packageRoots).map(([name, path]) =>
    [name, JSON.parse(readFileSync(resolve(directory, path, "package.json"), "utf8"))]));
  const ownerOf = path => Object.keys(packageRoots).find(name =>
    path.startsWith(`${resolve(directory, packageRoots[name])}${sep}`));
  const scopes = [...new Set(Object.keys(packageRoots).filter(name => name.startsWith("@")).map(name => `${name.split("/")[0]}/`))];
  for (const [name, manifest] of manifests) {
    const permitted = policy.packageDependencies?.[name];
    if (!permitted) continue;
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      if (scopes.some(scope => dependency.startsWith(scope)) && !permitted.includes(dependency)) {
        errors.push(`${name}: forbidden installed package dependency on ${dependency}`);
      }
    }
  }
  const workspaceTarget = (specifier) => {
    const name = [...manifests.keys()].find(name => specifier === name || specifier.startsWith(`${name}/`));
    if (!name) return undefined;
    const key = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const exports = manifests.get(name).exports ?? {};
    let path = exports[key];
    if (!path) {
      for (const [pattern, template] of Object.entries(exports)) {
        if (!pattern.endsWith("*") || !key.startsWith(pattern.slice(0, -1))) continue;
        path = template.replace("*", key.slice(pattern.length - 1));
        break;
      }
    }
    if (typeof path !== "string") return null;
    return resolve(directory, packageRoots[name], path);
  };
  const localName = (path) => relative(directory, path).replaceAll("\\", "/");
  for (const file of files) {
    const name = localName(file);
    const text = readFileSync(file, "utf8");
    if (policy.facades.includes(name)) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (source.statements.some(node => !ts.isExportDeclaration(node) || !node.moduleSpecifier)) {
        errors.push(`${name}: compatibility facade must contain only re-exports`);
      }
    }
    const lines = text.replace(/\n$/, "").split("\n").length;
    measured[name] = lines;
    const limit = policy.exceptions[name]?.maxLines ?? policy.maxLines;
    if (lines > limit) errors.push(`${name}: ${lines} lines exceeds ${limit}`);
    const dependencies = new Set();
    for (const specifier of moduleReferences(text, file)) {
      const target = specifier.startsWith(".")
        ? resolve(dirname(file), specifier.replace(/\.(?:m?js|tsx?)$/, ".ts"))
        : workspaceTarget(specifier);
      if (target === undefined) continue;
      if (target === null) {
        errors.push(`${name}: workspace import is not exported: ${specifier}`);
        continue;
      }
      if (!known.has(target)) {
        // JSON/grammar assets are checked by typecheck and pack:check.
        if (!/\.(json|lark)$/.test(specifier)) errors.push(`${name}: unresolved local module ${specifier}`);
        continue;
      }
      dependencies.add(target);
      const importer = ownerOf(file);
      const imported = ownerOf(target);
      if (importer && imported && importer !== imported) {
        if (specifier.startsWith(".")) errors.push(`${name}: cross-package imports must use exports: ${specifier}`);
        const pin = manifests.get(importer).dependencies?.[imported];
        if (pin !== manifests.get(imported).version) {
          errors.push(`${name}: ${imported} needs an exact runtime dependency, not an implicit workspace hoist`);
        }
      }
      const targetName = localName(target);
      if (policy.facades.includes(targetName) && !policy.facades.includes(name)) {
        errors.push(`${name}: implementation imports compatibility facade ${targetName}`);
      }
      for (const rule of policy.forbidden ?? []) {
        if (name.startsWith(rule.from) && targetName.startsWith(rule.to)) {
          errors.push(`${name}: forbidden dependency on ${targetName}`);
        }
      }
    }
    graph.set(file, dependencies);
  }
  for (const [name, exception] of Object.entries(policy.exceptions)) {
    if (!(name in measured)) errors.push(`${name}: stale line-budget exception`);
    else if (measured[name] <= policy.maxLines) errors.push(`${name}: remove unnecessary line-budget exception`);
    if (!exception.reason) errors.push(`${name}: exception needs an ownership/reduction rationale`);
  }
  for (const cycle of findCycles(graph)) errors.push(`cycle: ${cycle.map(localName).join(" -> ")}`);
  for (const rule of policy.forbiddenReachable ?? []) {
    for (const file of files) {
      if (!localName(file).startsWith(rule.from)) continue;
      const path = reachablePath(graph, file, (target) => localName(target).startsWith(rule.to));
      if (path) errors.push(`forbidden dependency path: ${path.map(localName).join(" -> ")}`);
    }
  }
  return { errors, measured, graph };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkArchitecture(codexSource, JSON.parse(readFileSync(policyPath, "utf8")));
  if (result.errors.length) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`✓ Codex: ${result.graph.size} modules; no cycles, facade back-edges or forbidden capability paths; line budgets hold`);
  }
}
