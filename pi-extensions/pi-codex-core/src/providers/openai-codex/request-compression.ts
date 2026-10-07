function isCodexOAuthRequest(url: string, headers: Headers, provider?: string): boolean {
	if (provider !== "openai" && provider !== "openai-codex") return false;
	if (url !== "https://api.openai.com/v1/responses" && url !== "https://chatgpt.com/backend-api/codex/responses") return false;
	const token = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
	if (!token) return false;
	try {
		const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		return typeof claims?.["https://api.openai.com/auth"]?.chatgpt_account_id === "string";
	} catch { return false; }
}

export function prepareSseBody(url: string, body: string, headers: Headers, provider?: string): string | Uint8Array {
	// Pi owns authentication. Compress only a prepared OAuth request to verified official routes.
	if (!isCodexOAuthRequest(url, headers, provider) || headers.has("content-encoding")) return body;
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
