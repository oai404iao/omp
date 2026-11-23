import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FeedbackRecord } from "./feedback.ts";

export function feedbackDirectory(): string {
	if (process.env.PI_CODING_AGENT_DIR) return join(getAgentDir(), "pi-rsi");
	const xdg = process.env.XDG_CONFIG_HOME;
	return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "pi", "agent", "pi-rsi");
}

export async function saveFeedback(input: Omit<FeedbackRecord, "id" | "createdAt">): Promise<void> {
	const directory = feedbackDirectory();
	const record: FeedbackRecord = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${record.id}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		} finally {
			await file.close();
		}
		await rename(temporary, join(directory, `${record.id}.json`));
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
