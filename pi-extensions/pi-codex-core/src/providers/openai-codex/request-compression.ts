import { DEFAULT_CODEX_BASE_URL } from "./constants.js";

export function prepareSseBody(url: string, body: string, headers: Headers, apiKeyMode: boolean): string | Uint8Array {
	if (apiKeyMode || url !== `${DEFAULT_CODEX_BASE_URL}/codex/responses` || headers.has("content-encoding")) return body;
	const zlib = process.getBuiltinModule("node:zlib");
	if (typeof zlib.zstdCompressSync !== "function") return body;
	try {
		const compressed = zlib.zstdCompressSync(body, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
		});
		if (compressed.byteLength >= Buffer.byteLength(body)) return body;
		headers.set("content-encoding", "zstd");
		headers.delete("content-length");
		return compressed;
	} catch {
		return body;
	}
}
