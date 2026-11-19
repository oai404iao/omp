import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexTools from "@oai404iao/pi-codex-tools";
import codexCore from "@oai404iao/pi-codex-core";

export default function codexMinimalTools(pi: ExtensionAPI): void {
	codexCore(pi);
	codexTools(pi);
}
