import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Document, parseAllDocuments, stringify } from "yaml";

function lockDocuments(path) {
  const documents = parseAllDocuments(readFileSync(path, "utf8"));
  for (const document of documents) {
    if (document.errors.length) throw document.errors[0];
  }
  // pnpm 12 puts its package-manager tooling in a separate first document.
  const candidates = documents.flatMap((document, index) => document.has("settings") ? [index] : []);
  const index = documents.length === 1 ? 0 : candidates.length === 1 ? candidates[0] : -1;
  if (index < 0) throw new Error(`Expected one application lockfile document: ${path}`);
  return { documents, index };
}

export function readPnpmLock(path) {
  const { documents, index } = lockDocuments(path);
  return documents[index].toJS();
}

export function writePnpmLock(path, lock) {
  if (!existsSync(path)) {
    writeFileSync(path, stringify(lock));
    return;
  }
  const { documents, index } = lockDocuments(path);
  documents[index].contents = new Document(lock).contents;
  writeFileSync(path, documents.map(document => document.toString()).join(""));
}
