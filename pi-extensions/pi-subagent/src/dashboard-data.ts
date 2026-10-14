import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { DashboardActivity, DashboardAgent, DashboardContext, DashboardUsage } from "./dashboard-types.ts";
import { DESCRIPTOR_CUSTOM_TYPE, MESSAGE_CUSTOM_TYPE } from "./store.ts";
import { ACTIVITY_LIMIT, dashboardText, TELEMETRY_CUSTOM_TYPE, type RunTelemetryEntry, type TelemetrySnapshot } from "./telemetry.ts";
import { responseActivity, toolActivity, toolResultActivity } from "./activity-preview.ts";
import type { AgentRecord } from "./types.ts";

function emptyUsage(available: boolean): DashboardUsage {
	return {
		available, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: available ? 0 : null, requests: 0, tools: 0, nestedTools: 0, nestedToolsPartial: false,
	};
}

function ownedEntries(record: AgentRecord, entries: readonly SessionEntry[]): readonly SessionEntry[] | undefined {
	const boundary = entries.findIndex(entry => entry.type === "custom" && entry.customType === DESCRIPTOR_CUSTOM_TYPE &&
		(entry.data as { id?: unknown } | undefined)?.id === record.descriptor.id);
	return boundary < 0 ? undefined : entries.slice(boundary + 1);
}

function addUsage(target: DashboardUsage, usage: Usage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
	const cost = usage.cost?.total;
	if (!Number.isFinite(cost) || cost < 0 || (cost === 0 && usage.totalTokens > 0)) target.cost = null;
	else if (target.cost !== null) target.cost += cost;
}

function usageTotals(entries: readonly SessionEntry[], live?: TelemetrySnapshot): DashboardUsage {
	const usage = emptyUsage(true);
	const tools = new Set(live?.toolIds);
	const nested = new Set(live?.nestedToolIds);
	const recordedNested = new Set<string>();
	const results = new Set<string>();
	const seenEntries = new Set<string>();
	for (const entry of entries) {
		if (seenEntries.has(entry.id)) continue;
		seenEntries.add(entry.id);
		if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addUsage(usage, entry.usage);
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant" && message.stopReason !== "pending") {
			usage.requests++;
			addUsage(usage, message.usage);
			for (const block of message.content) if (block.type === "toolCall") tools.add(block.id);
		} else if (message.role === "toolResult") {
			tools.add(message.toolCallId);
			if (results.has(message.toolCallId)) continue;
			results.add(message.toolCallId);
			if (message.usage) addUsage(usage, message.usage);
			if (message.nestedCalls) {
				for (const call of message.nestedCalls.calls) {
					nested.add(call.id);
					recordedNested.add(call.id);
				}
				if (!message.nestedCalls.complete) usage.nestedToolsPartial = true;
			}
		}
	}
	usage.tools = tools.size;
	usage.nestedTools = nested.size;
	// An unfinished top-level call may have made nested calls that never reached
	// its bounded transcript receipt. Absence of a receipt is not evidence of zero.
	if ([...tools].some(id => !results.has(id)) || [...nested].some(id => !recordedNested.has(id))) {
		usage.nestedToolsPartial = true;
	}
	return usage;
}

function telemetry(entry: SessionEntry): RunTelemetryEntry | undefined {
	if (entry.type !== "custom" || entry.customType !== TELEMETRY_CUSTOM_TYPE) return undefined;
	const data = entry.data as RunTelemetryEntry | undefined;
	return data?.version === 1 && (data.kind === "run-start" || data.kind === "run-end") &&
		typeof data.runId === "string" && Number.isFinite(data.startedAt) ? data : undefined;
}

function legacyDurations(entries: readonly SessionEntry[], live?: TelemetrySnapshot) {
	const open = new Map<string, RunTelemetryEntry>();
	const finished = new Set<string>();
	let total = 0;
	let partial = live?.timingPartial ?? false;
	for (const entry of entries) {
		const data = telemetry(entry);
		if (data?.kind === "run-start" && !finished.has(data.runId)) open.set(data.runId, data);
		else if (data?.kind === "run-end" && !finished.has(data.runId)) {
			const start = open.get(data.runId);
			if (start?.startedAt === data.startedAt && Number.isFinite(data.durationMs) && data.durationMs! >= 0) {
				total += data.durationMs!;
				finished.add(data.runId);
			} else partial = true;
			open.delete(data.runId);
		} else if (entry.type === "message" && entry.message.role === "assistant" && open.size === 0) partial = true;
	}
	for (const id of open.keys()) if (live?.activeSince === undefined || id !== live.runId) partial = true;
	return {
		durationMs: finished.size || live?.activeSince !== undefined ? total : undefined,
		durationPartial: partial,
		...(live?.activeSince !== undefined ? { activeSince: live.activeSince } : {}),
	};
}

function durations(
	entries: readonly SessionEntry[], records: readonly RunTelemetryEntry[],
	boundaryId: string, live?: TelemetrySnapshot,
) {
	const positions = new Map(entries.map((entry, index) => [entry.id, index]));
	positions.set(boundaryId, -1);
	const open = new Map<string, RunTelemetryEntry>();
	const finished = new Set<string>();
	const ranges: [number, number][] = [];
	let total = 0;
	let partial = live?.timingPartial ?? false;
	for (const data of records) {
		if (data.kind === "run-start" && !finished.has(data.runId)) open.set(data.runId, data);
		else if (data.kind === "run-end" && !finished.has(data.runId)) {
			const start = open.get(data.runId);
			if (start?.startedAt === data.startedAt && Number.isFinite(data.durationMs) && data.durationMs! >= 0) {
				total += data.durationMs!;
				finished.add(data.runId);
				const from = typeof start.anchorId === "string" ? positions.get(start.anchorId) : undefined;
				const to = typeof data.anchorId === "string" ? positions.get(data.anchorId) : undefined;
				if (from !== undefined && to !== undefined && to >= from) ranges.push([from, to]);
				else partial = true;
			} else partial = true;
			open.delete(data.runId);
		}
	}
	for (const [id, start] of open) {
		if (id !== live?.runId || live.activeSince === undefined) partial = true;
		else {
			const from = typeof start.anchorId === "string" ? positions.get(start.anchorId) : undefined;
			if (from !== undefined) ranges.push([from, entries.length - 1]);
			else partial = true;
		}
	}
	if (entries.some((entry, index) => entry.type === "message" && entry.message.role === "assistant" &&
		!ranges.some(([from, to]) => index > from && index <= to))) partial = true;
	return {
		durationMs: finished.size || live?.activeSince !== undefined ? total : undefined,
		durationPartial: partial,
		...(live?.activeSince !== undefined ? { activeSince: live.activeSince } : {}),
	};
}

function envelopeDetails(entry: SessionEntry): Record<string, unknown> | undefined {
	const details = entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE ? entry.details :
		entry.type === "message" && entry.message.role === "custom" && entry.message.customType === MESSAGE_CUSTOM_TYPE ?
			entry.message.details : undefined;
	return details && typeof details === "object" ? details as Record<string, unknown> : undefined;
}

function deliveredTasks(entry: SessionEntry): { id: string; text: string }[] | undefined {
	const tasks = envelopeDetails(entry)?.tasks;
	if (!Array.isArray(tasks)) return undefined;
	return tasks.filter((task): task is { id: string; text: string } =>
		task && typeof task.id === "string" && typeof task.text === "string");
}

function activityAndTask(
	record: AgentRecord, entries: readonly SessionEntry[], live?: TelemetrySnapshot,
	records?: readonly RunTelemetryEntry[], boundaryId?: string,
) {
	const activity = new Map<string, DashboardActivity>();
	const responseTimes = new Set<number>();
	const responseIds = new Set<string>();
	const completedTools = new Set<string>();
	const finalizedTopTools = new Set<string>();
	const toolInputs = new Map<string, ReturnType<typeof toolActivity>>();
	let task: string | undefined;
	let hasDeliveredTask = false;
	let context: DashboardContext | undefined;
	const put = (item: DashboardActivity) => {
		activity.delete(item.id);
		activity.set(item.id, item);
		if (activity.size > ACTIVITY_LIMIT) {
			const oldest = [...activity.values()].reduce((a, b) => a.timestamp <= b.timestamp ? a : b);
			activity.delete(oldest.id);
		}
	};
	for (const entry of entries) {
		const timestamp = Date.parse(entry.timestamp);
		const tasks = deliveredTasks(entry);
		const isEnvelope = (entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE) ||
			(entry.type === "message" && entry.message.role === "custom" && entry.message.customType === MESSAGE_CUSTOM_TYPE);
		if (isEnvelope) {
			// Old envelopes have no structured task metadata. Do not mislabel a
			// queued follow-up as current when an older task was already delivered.
			const content = entry.type === "custom_message" ? entry.content :
				entry.type === "message" && entry.message.role === "custom" ? entry.message.content : "";
			if (tasks?.length || (tasks === undefined && typeof content === "string" && /^\[Agent task: /m.test(content))) {
				hasDeliveredTask = true;
			}
			for (const delivered of tasks ?? []) {
				task = delivered.text;
				put({ id: `task:${delivered.id}`, timestamp, kind: "task", status: "info", label: "Task delivered",
					summary: dashboardText(delivered.text) });
			}
			const ids = envelopeDetails(entry)?.messageIds;
			const count = Array.isArray(ids) ? Math.max(0, new Set(ids.filter(id => typeof id === "string")).size - (tasks?.length ?? 0)) : 0;
			if (count) put({
				id: `message:${entry.id}`, timestamp, kind: "message", status: "info", label: "Messages delivered",
				summary: `${count} ${count === 1 ? "message" : "messages"}`,
			});
		}
		const run = telemetry(entry);
		if (run) {
			if (run.kind === "run-end") context = run.context ? { ...run.context, live: false } : undefined;
			put({
				id: `run:${run.runId}`, timestamp, kind: "run",
				status: run.kind === "run-start" ? (live?.runId === run.runId && live.activeSince !== undefined ? "running" : "interrupted") :
					run.status === "completed" ? "success" : run.status === "interrupted" ? "interrupted" : "error",
				label: run.kind === "run-start" ? "Run started" : "Run ended", summary: run.status ?? "",
			});
		}
		if (entry.type === "compaction") {
			if (context) context = { ...context, tokens: null, percent: null, timestamp };
			put({ id: `compaction:${entry.id}`, timestamp, kind: "compaction", status: "success", label: "Compaction", summary: "" });
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant" && message.stopReason !== "pending") {
			responseTimes.add(message.timestamp);
			responseIds.add(`response:${entry.id}`);
			put({
				id: `response:${entry.id}`, timestamp: message.timestamp, kind: "response",
				status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "interrupted" : "success",
				label: "Response",
				...responseActivity(message),
			});
			for (const block of message.content) if (block.type === "toolCall") {
				const id = `tool:${block.id}`;
				const content = toolActivity(block.name, block.arguments);
				toolInputs.set(id, content);
				while (toolInputs.size > ACTIVITY_LIMIT) toolInputs.delete(toolInputs.keys().next().value!);
				put({ id, timestamp: message.timestamp, kind: "tool",
					status: live?.toolIds.includes(block.id) ? "running" : "interrupted",
					label: dashboardText(block.name, 80), ...content });
			}
		} else if (message.role === "toolResult") {
			const id = `tool:${message.toolCallId}`;
			completedTools.add(id);
			finalizedTopTools.add(id);
			put({ id, timestamp: message.timestamp, kind: "tool", status: message.isError ? "error" : "success",
				label: dashboardText(message.toolName, 80),
				...toolResultActivity(toolInputs.get(id) ?? { summary: "" }, message, message.isError) });
			toolInputs.delete(id);
			for (const call of message.nestedCalls?.calls ?? []) {
				if (call.status !== "unfinished") completedTools.add(`tool:${call.id}`);
				put({
					id: `tool:${call.id}`, timestamp: message.timestamp, kind: "tool",
					status: call.status === "ok" ? "success" : call.status === "error" ? "error" : "interrupted",
					label: dashboardText(call.name, 80), ...toolActivity(call.name, call.arguments),
				});
			}
		}
	}
	if (records) {
		const positions = new Map(entries.map((entry, index) => [entry.id, index]));
		if (boundaryId) positions.set(boundaryId, -1);
		let contextPosition = -1;
		context = undefined;
		for (const run of records) {
			const position = typeof run.anchorId === "string" ? positions.get(run.anchorId) : undefined;
			if (position === undefined) continue;
			if (run.kind === "run-end") {
				context = run.context ? { ...run.context, live: false } : undefined;
				contextPosition = position;
			}
			put({
				id: `run:${run.runId}`, timestamp: run.timestamp ?? run.startedAt, kind: "run",
				status: run.kind === "run-start" ? (live?.runId === run.runId && live.activeSince !== undefined ? "running" : "interrupted") :
					run.status === "completed" ? "success" : run.status === "interrupted" ? "interrupted" : "error",
				label: run.kind === "run-start" ? "Run started" : "Run ended", summary: run.status ?? "",
			});
		}
		let compactionIndex = -1;
		for (let index = 0; index < entries.length; index++) if (entries[index]!.type === "compaction") compactionIndex = index;
		if (context && compactionIndex > contextPosition) {
			context = { ...context, tokens: null, percent: null, timestamp: Date.parse(entries[compactionIndex]!.timestamp) };
		}
	}
	for (const item of live?.activity ?? []) {
		if (item.kind === "response" && (responseIds.has(item.id) ||
			(item.status !== "running" && responseTimes.has(item.timestamp)))) continue;
		if (item.kind === "tool" && finalizedTopTools.has(item.id)) continue;
		if (item.kind === "tool" && completedTools.has(item.id)) {
			const completed = activity.get(item.id);
			if (completed) put({ ...completed, preview: item.preview ?? completed.preview });
			continue;
		}
		put({ ...item });
	}
	if (task === undefined && !hasDeliveredTask) task = record.mailbox.find(message => message.kind === "task")?.text;
	return {
		task: task === undefined ? "" : task.slice(0, 131072).split(/\r?\n/).map(line => dashboardText(line, 131072)).join("\n"),
		topic: task === undefined ? "Task unavailable" : dashboardText(task.split(/\r?\n/).find(line => line.trim()) ?? "", 160),
		context: live ? live.context : context,
		activity: [...activity.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, ACTIVITY_LIMIT),
	};
}

export function unavailableDashboardAgent(record: AgentRecord, error: string): DashboardAgent {
	const { descriptor } = record;
	return {
		path: descriptor.path, parentPath: descriptor.parentPath, type: descriptor.agent.name,
		model: `${descriptor.model.provider}/${descriptor.model.id}`, thinkingLevel: descriptor.thinkingLevel,
		createdAt: descriptor.createdAt, status: record.status, topic: "Task unavailable", task: "",
		...(record.error ? { error: dashboardText(record.error, 2048) } : {}),
		dataError: dashboardText(error, 512), usage: emptyUsage(false), durationPartial: true, activity: [],
	};
}

export function buildDashboardAgent(
	record: AgentRecord,
	entries: readonly SessionEntry[],
	live?: TelemetrySnapshot,
	branch: readonly SessionEntry[] = entries,
	persistedRecords?: readonly RunTelemetryEntry[],
): DashboardAgent {
	const owned = ownedEntries(record, entries);
	if (!owned) return unavailableDashboardAgent(record, "Agent descriptor boundary is missing; statistics unavailable.");
	const current = ownedEntries(record, branch) ?? [];
	const boundaryId = entries[entries.length - owned.length - 1]!.id;
	const { dataError: _, ...base } = unavailableDashboardAgent(record, "");
	return {
		...base, usage: usageTotals(owned, live),
		...(persistedRecords ? durations(owned, persistedRecords, boundaryId, live) : legacyDurations(owned, live)),
		...activityAndTask(record, current, live, persistedRecords, boundaryId),
	};
}
