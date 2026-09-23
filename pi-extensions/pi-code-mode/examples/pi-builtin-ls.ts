import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiBuiltinLs } from "../src/builtin-adapters.ts";

export default function builtinLs(pi: ExtensionAPI) {
	registerPiBuiltinLs(pi);
}
