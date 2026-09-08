import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { glyphs } from "@oai404iao/pi-codex-runtime/internal/glyphs";
import { themeBold, themeFg } from "@oai404iao/pi-codex-runtime/internal/utils/theme";
import { WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, buildWebSearchSummaryText, webSearchActivityDetail, webSearchActivityHosts, type SurfacedWebSearch } from "./activity.js";

export function registerWebSearchActivityRenderer(pi: ExtensionAPI): void {


	pi.registerMessageRenderer<{ searches?: SurfacedWebSearch[] }>(WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, (message, options, theme) => {
		const searches = message.details?.searches ?? [];
		const container = new Container();
		if (searches.length > 0) {
			searches.forEach((search, index) => {
					const completed = search.completed ?? search.status === "completed";
					const header = completed ? "Searched the web" : "Searching the web";
					const detail = webSearchActivityDetail(search);
					const separator = detail ? (completed ? " for " : " ") : "";
					const bullet = themeFg(theme, completed ? "muted" : "accent", glyphs().bullet);
					const lines = [
						`${bullet}${themeFg(theme, "text", themeBold(theme, header))}${themeFg(theme, "dim", `${separator}${detail}`)}`,
					];
					const hosts = webSearchActivityHosts(search);
					if (hosts.length > 0) {
						const shown = hosts.slice(0, 8);
						const hostLine = shown.map((host) => themeFg(theme, "accent", host));
						if (hosts.length > shown.length) {
							hostLine.push(themeFg(theme, "dim", `+${hosts.length - shown.length}`));
						}
						lines.push(`  ${hostLine.join(themeFg(theme, "dim", glyphs().dot))}`);
					}
					container.addChild(new Text(`${index > 0 ? "\n" : ""}${lines.join("\n")}`, 0, 0));
				});
		} else {
			container.addChild(new Text(themeFg(theme, "text", themeBold(theme, buildWebSearchSummaryText(searches))), 0, 0));
		}
		if (options.expanded) {
			const content = typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
			container.addChild(new Text(`\n${themeFg(theme, "dim", content)}`, 0, 0));
		}
		return container;
	});
}
