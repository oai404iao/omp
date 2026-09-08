import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-ast";

const root = fileURLToPath(new URL("../", import.meta.url));
export const codexSource = resolve(root, "pi-extensions/pi-codex-minimal-tools/src");
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

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  }).sort();
}

export function checkArchitecture(directory, policy) {
  const files = sources(directory);
  const known = new Set(files);
  const graph = new Map();
  const errors = [];
  const measured = {};
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
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier.replace(/\.(?:m?js|tsx?)$/, ".ts"));
      if (!known.has(target)) {
        // JSON/grammar assets are checked by typecheck and pack:check.
        if (!/\.(json|lark)$/.test(specifier)) errors.push(`${name}: unresolved local module ${specifier}`);
        continue;
      }
      dependencies.add(target);
      const targetName = localName(target);
      if (policy.facades.includes(targetName)) {
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
  return { errors, measured, graph };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkArchitecture(codexSource, JSON.parse(readFileSync(policyPath, "utf8")));
  if (result.errors.length) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`✓ Codex: ${result.graph.size} modules; no local import cycles or facade back-edges; line budgets hold`);
  }
}
