const [jitiPath, entry] = process.argv.slice(2);
const { createJiti } = await import(jitiPath);
const jiti = createJiti(entry, { moduleCache: false, fsCache: false });
const module = await jiti.import(entry);
const state = await module.loadCodexIntegration();
console.log(JSON.stringify({ status: state.status, cause: state.cause ? String(state.cause) : undefined }));
