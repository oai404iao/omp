import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexImagegen from "@oai404iao/pi-codex-imagegen";
import codexWebSearch from "@oai404iao/pi-codex-web-search";
import codexCore from "@oai404iao/pi-codex-core";

/** Legacy installation entry; shared session claims deduplicate separately installed packages. */
export default function codexMinimalTools(pi: ExtensionAPI): void {
	codexImagegen(pi);
	codexWebSearch(pi);
	codexCore(pi);
}
