import assert from "node:assert/strict";
import { test } from "node:test";
import core from "@oai404iao/pi-codex-core";
import web from "@oai404iao/pi-codex-web-search";
import { createCompositionHost, withCompositionDirectory } from "./support/composition-host.js";

for (const source of ["sdk", "builtin"]) for (const bound of [false, true]) {
	test(`foreign ${source} patch cannot be activated or suppress native tools, previously bound=${bound}`, () =>
		withCompositionDirectory(async (directory) => {
			const host = createCompositionHost(directory);
			const pi = host.api();
			let releases = 0;
			const off = pi.events.on("@oai404iao/pi-code-mode:direct-owner/v1", (value) => {
				(value as any).accept({ version: 1, create(_pi: unknown, { name }: { name: string }) {
					return { binding: { version: 1, name, acquire() {} }, activeIntent: true,
						projectActive: (active: boolean) => active, reconcile: () => true, dispose() { releases++; } };
				} });
			});
			try {
				core(pi);
				if (bound) await host.emit("session_start");
				const original = host.tools.get("apply_patch");
				host.tools.set("apply_patch", { ...original,
					sourceInfo: { path: `<${source}:apply_patch>`, source, scope: "temporary", origin: "top-level" } });
				for (const active of [false, true]) {
					pi.setActiveTools(["read", "edit", "write", ...(active ? ["apply_patch"] : [])]);
					await host.emit(bound ? "session_tree" : "session_start");
					assert.equal(host.active().includes("apply_patch"), active);
					assert(host.active().includes("edit"));
					assert(host.active().includes("write"));
				}
				assert.equal(releases, bound ? 1 : 0);
			} finally { off(); host.dispose(); }
		}));
}

test("Codex shutdown attempts every owner and restores native tools; failed restoration remains retryable", () =>
	withCompositionDirectory(async (directory) => {
		const host = createCompositionHost(directory);
		const pi = host.api();
		const attempts = new Map<string, number>();
		let restorationFails = false;
		const write = pi.setActiveTools;
		pi.setActiveTools = (names) => {
			if (restorationFails && names.includes("edit")) {
				restorationFails = false;
				throw new Error("native restore failed");
			}
			write(names);
		};
		const off = pi.events.on("@oai404iao/pi-code-mode:direct-owner/v1", (value) => {
			(value as any).accept({ version: 1, create(_pi: unknown, { name }: { name: string }) {
				return { binding: { version: 1, name, acquire() {} }, activeIntent: true,
					projectActive: (active: boolean) => active, reconcile: () => true,
					dispose() {
						attempts.set(name, (attempts.get(name) ?? 0) + 1);
						if (name === "apply_patch" && attempts.get(name) === 1) throw new Error("patch release failed");
					} };
			} });
		});
		try {
			core(pi); web(host.api());
			await host.emit("session_start");
			assert(!host.active().includes("edit"));
			restorationFails = true;
			await assert.rejects(host.emit("session_shutdown"), (error: AggregateError) => {
				assert.equal(error.errors.length, 2, "owner failure must not skip native restoration");
				return true;
			});
			assert.equal(attempts.get("web_search"), 1, "another owner must still be released");
			await host.emit("session_shutdown");
			assert.equal(attempts.get("apply_patch"), 2);
			assert.equal(attempts.get("web_search"), 1);
			assert(host.active().includes("edit"));
			assert(host.active().includes("write"));
		} finally { off(); host.dispose(); }
	}));
