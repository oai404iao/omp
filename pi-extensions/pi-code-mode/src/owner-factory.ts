import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodeModeDirectBinding } from "./direct-binding.ts";

const DISCOVER_OWNER = "@oai404iao/pi-code-mode:direct-owner/v1";
export const OWNER_CHANGED = "@oai404iao/pi-code-mode:direct-owner-changed/v1";
/** Optional structural protocol: owner packages never import this package. */
export function installOwnerFactory(pi: ExtensionAPI): () => void {
	type Control = ReturnType<typeof createCodeModeDirectBinding>;
	const controls = new Set<Control>();
	let disposed = false;
	let closing = false;
	let disposing = false;
	const factory = Object.freeze({ version: 1, create(owner: ExtensionAPI, options: { name: string; sourcePath: string }) {
		if (closing || disposed || controls.size >= 64) throw new Error("Code Mode owner factory closing/disposed/full");
		const control = createCodeModeDirectBinding(owner, options);
		const dispose = control.dispose;
		control.dispose = () => { dispose(); controls.delete(control); };
		controls.add(control);
		return control;
	} });
	const off = pi.events.on(DISCOVER_OWNER, (message) => {
		const request = message as { version?: number; accept?: (value: unknown) => void } | undefined;
		if (!closing && !disposed && request?.version === 1 && typeof request.accept === "function") request.accept(factory);
	});
	pi.events.emit(OWNER_CHANGED, { version: 1 });
	return () => {
		if (disposed || disposing) return;
		closing = true;
		disposing = true;
		try {
			// Failed receipts remain live for retry; closing forbids acquisition.
			for (const control of controls) control.dispose();
			disposed = true; off();
			pi.events.emit(OWNER_CHANGED, { version: 1 });
		} finally { disposing = false; }
	};
}
