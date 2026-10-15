import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexApplyPatch from "./apply-patch.js";
import codexImagegen from "./imagegen.js";
import codexWebSearch from "./web-search.js";

export default function codexTools(pi: ExtensionAPI): void {
	codexImagegen(pi);
	codexWebSearch(pi);
	codexApplyPatch(pi);
}
