import { uuidv7 } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionView } from "./providers.ts";
import type {
	SubagentRunResult,
	SubagentStopReason,
} from "./types.ts";

export const COMPLETION_UPDATE_CUSTOM_TYPE =
	"pi-subagent/completion-update";
export const COMPLETION_DELIVERY_CUSTOM_TYPE =
	"pi-subagent/completion-delivery";
export const COMPLETION_DELIVERY_RELEASE_CUSTOM_TYPE =
	"pi-subagent/completion-delivery-release";
export const COMPLETION_FAILURE_CUSTOM_TYPE =
	"pi-subagent/completion-undelivered";
export const COMPLETION_MAILBOX_VERSION = 1;
export const MAX_COMPLETION_OUTPUT_CHARS = 2 * 1024 * 1024;
export const MAX_COMPLETIONS_PER_DELIVERY = 256;

const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STOP_REASONS = new Set<SubagentStopReason>([
	"completed",
	"aborted",
	"error",
	"max-tokens",
]);

export interface CompletionUpdate {
	version: 1;
	completionId: string;
	parentAgentId: string;
	childAgentId: string;
	turnId: string;
	stopReason: SubagentStopReason;
	output: string;
	outputTruncated: boolean;
	omittedBytes?: number;
	createdAt: string;
}

export interface CompletionDelivery {
	version: 1;
	deliveryId: string;
	runtimeId: string;
	parentAgentId: string;
	toolCallId: string;
	completionIds: string[];
	createdAt: string;
}

export interface CompletionDeliveryRelease {
	version: 1;
	releaseId: string;
	runtimeId: string;
	parentAgentId: string;
	deliveryIds: string[];
	reason: string;
	createdAt: string;
}

export interface CompletionMailboxSnapshot {
	updates: CompletionUpdate[];
	unread: CompletionUpdate[];
	available: CompletionUpdate[];
	currentRuntimeReservations: CompletionDelivery[];
}

export type CompletionMailboxFold =
	| { kind: "valid"; snapshot: CompletionMailboxSnapshot }
	| { kind: "corrupt"; message: string };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, field: string): UnknownRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value as UnknownRecord;
}

function uuid(value: unknown, field: string): string {
	if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
		throw new Error(`${field} must be a UUIDv7 id`);
	}
	return value;
}

function text(
	value: unknown,
	field: string,
	options: { allowEmpty?: boolean; maxLength: number },
): string {
	if (
		typeof value !== "string"
		|| (!options.allowEmpty && value.trim().length === 0)
		|| value.length > options.maxLength
	) {
		throw new Error(
			`${field} must be ${options.allowEmpty ? "a" : "a non-empty"} string of at most ${options.maxLength} characters`,
		);
	}
	return value;
}

function isoDate(value: unknown, field: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		throw new Error(`${field} must be an ISO date string`);
	}
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}

function optionalNatural(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}

function parseUpdate(value: unknown): CompletionUpdate {
	const input = record(value, "completion update");
	if (input.version !== COMPLETION_MAILBOX_VERSION) {
		throw new Error(
			`unsupported completion update version: ${String(input.version)}`,
		);
	}
	const stopReason = text(input.stopReason, "completion update.stopReason", {
		maxLength: 32,
	}) as SubagentStopReason;
	if (!STOP_REASONS.has(stopReason)) {
		throw new Error(`unsupported completion stop reason: ${stopReason}`);
	}
	const outputTruncated = boolean(
		input.outputTruncated,
		"completion update.outputTruncated",
	);
	const omittedBytes = optionalNatural(
		input.omittedBytes,
		"completion update.omittedBytes",
	);
	if (!outputTruncated && omittedBytes !== undefined) {
		throw new Error(
			"completion update.omittedBytes requires outputTruncated",
		);
	}
	return {
		version: COMPLETION_MAILBOX_VERSION,
		completionId: uuid(
			input.completionId,
			"completion update.completionId",
		),
		parentAgentId: uuid(
			input.parentAgentId,
			"completion update.parentAgentId",
		),
		childAgentId: uuid(
			input.childAgentId,
			"completion update.childAgentId",
		),
		turnId: uuid(input.turnId, "completion update.turnId"),
		stopReason,
		output: text(input.output, "completion update.output", {
			allowEmpty: true,
			maxLength: MAX_COMPLETION_OUTPUT_CHARS,
		}),
		outputTruncated,
		...(omittedBytes !== undefined ? { omittedBytes } : {}),
		createdAt: isoDate(
			input.createdAt,
			"completion update.createdAt",
		),
	};
}

function parseDelivery(value: unknown): CompletionDelivery {
	const input = record(value, "completion delivery");
	if (input.version !== COMPLETION_MAILBOX_VERSION) {
		throw new Error(
			`unsupported completion delivery version: ${String(input.version)}`,
		);
	}
	if (
		!Array.isArray(input.completionIds)
		|| input.completionIds.length === 0
		|| input.completionIds.length > MAX_COMPLETIONS_PER_DELIVERY
	) {
		throw new Error(
			`completion delivery.completionIds must contain 1-${MAX_COMPLETIONS_PER_DELIVERY} ids`,
		);
	}
	const completionIds = input.completionIds.map((value, index) =>
		uuid(value, `completion delivery.completionIds[${index}]`),
	);
	if (new Set(completionIds).size !== completionIds.length) {
		throw new Error("completion delivery.completionIds contains a duplicate id");
	}
	return {
		version: COMPLETION_MAILBOX_VERSION,
		deliveryId: uuid(
			input.deliveryId,
			"completion delivery.deliveryId",
		),
		runtimeId: uuid(input.runtimeId, "completion delivery.runtimeId"),
		parentAgentId: uuid(
			input.parentAgentId,
			"completion delivery.parentAgentId",
		),
		toolCallId: text(
			input.toolCallId,
			"completion delivery.toolCallId",
			{ maxLength: 512 },
		),
		completionIds,
		createdAt: isoDate(
			input.createdAt,
			"completion delivery.createdAt",
		),
	};
}

function parseDeliveryRelease(value: unknown): CompletionDeliveryRelease {
	const input = record(value, "completion delivery release");
	if (input.version !== COMPLETION_MAILBOX_VERSION) {
		throw new Error(
			`unsupported completion delivery release version: ${String(input.version)}`,
		);
	}
	if (
		!Array.isArray(input.deliveryIds)
		|| input.deliveryIds.length === 0
		|| input.deliveryIds.length > MAX_COMPLETIONS_PER_DELIVERY
	) {
		throw new Error(
			`completion delivery release.deliveryIds must contain 1-${MAX_COMPLETIONS_PER_DELIVERY} ids`,
		);
	}
	const deliveryIds = input.deliveryIds.map((value, index) =>
		uuid(value, `completion delivery release.deliveryIds[${index}]`),
	);
	if (new Set(deliveryIds).size !== deliveryIds.length) {
		throw new Error(
			"completion delivery release.deliveryIds contains a duplicate id",
		);
	}
	return {
		version: COMPLETION_MAILBOX_VERSION,
		releaseId: uuid(
			input.releaseId,
			"completion delivery release.releaseId",
		),
		runtimeId: uuid(
			input.runtimeId,
			"completion delivery release.runtimeId",
		),
		parentAgentId: uuid(
			input.parentAgentId,
			"completion delivery release.parentAgentId",
		),
		deliveryIds,
		reason: text(input.reason, "completion delivery release.reason", {
			maxLength: 1000,
		}),
		createdAt: isoDate(
			input.createdAt,
			"completion delivery release.createdAt",
		),
	};
}

function committedToolResultIndexes(
	entries: readonly SessionEntry[],
): Map<string, number[]> {
	const indexes = new Map<string, number[]>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (
			entry.type !== "message"
			|| entry.message.role !== "toolResult"
			|| entry.message.toolName !== "wait_agent"
			|| entry.message.isError
		) {
			continue;
		}
		const existing = indexes.get(entry.message.toolCallId) ?? [];
		existing.push(index);
		indexes.set(entry.message.toolCallId, existing);
	}
	return indexes;
}

function foldOrThrow(
	entries: readonly SessionEntry[],
	parentAgentId: string,
	activeRuntimeId?: string,
): CompletionMailboxSnapshot {
	uuid(parentAgentId, "completion mailbox parentAgentId");
	if (activeRuntimeId !== undefined) {
		uuid(activeRuntimeId, "completion mailbox activeRuntimeId");
	}
	const toolResults = committedToolResultIndexes(entries);
	const updates: CompletionUpdate[] = [];
	const byId = new Map<string, CompletionUpdate>();
	const turnKeys = new Set<string>();
	const deliveryIds = new Set<string>();
	const releaseIds = new Set<string>();
	const releasedDeliveryIds = new Set<string>();
	const deliveries: Array<{
		index: number;
		delivery: CompletionDelivery;
		committed: boolean;
	}> = [];

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.type !== "custom") continue;
		if (entry.customType === COMPLETION_UPDATE_CUSTOM_TYPE) {
			const update = parseUpdate(entry.data);
			if (update.parentAgentId !== parentAgentId) {
				throw new Error(
					`completion ${update.completionId} belongs to another parent`,
				);
			}
			if (byId.has(update.completionId)) {
				throw new Error(
					`duplicate completion id: ${update.completionId}`,
				);
			}
			const turnKey = `${update.childAgentId}:${update.turnId}`;
			if (turnKeys.has(turnKey)) {
				throw new Error(
					`duplicate completion for child turn ${turnKey}`,
				);
			}
			turnKeys.add(turnKey);
			byId.set(update.completionId, update);
			updates.push(update);
			continue;
		}
		if (entry.customType !== COMPLETION_DELIVERY_CUSTOM_TYPE) continue;
		const delivery = parseDelivery(entry.data);
		if (deliveryIds.has(delivery.deliveryId)) {
			throw new Error(
				`duplicate completion delivery id: ${delivery.deliveryId}`,
			);
		}
		deliveryIds.add(delivery.deliveryId);
		if (delivery.parentAgentId !== parentAgentId) {
			throw new Error(
				`completion delivery ${delivery.deliveryId} belongs to another parent`,
			);
		}
		for (const completionId of delivery.completionIds) {
			if (!byId.has(completionId)) {
				throw new Error(
					`completion delivery ${delivery.deliveryId} references unavailable completion ${completionId}`,
				);
			}
		}
		const committed = (toolResults.get(delivery.toolCallId) ?? []).some(
			(toolResultIndex) => toolResultIndex > index,
		);
		deliveries.push({ index, delivery, committed });
	}

	for (let releaseIndex = 0; releaseIndex < entries.length; releaseIndex++) {
		const entry = entries[releaseIndex]!;
		if (
			entry.type !== "custom"
			|| entry.customType !== COMPLETION_DELIVERY_RELEASE_CUSTOM_TYPE
		) {
			continue;
		}
		const release = parseDeliveryRelease(entry.data);
		if (releaseIds.has(release.releaseId)) {
			throw new Error(
				`duplicate completion delivery release id: ${release.releaseId}`,
			);
		}
		releaseIds.add(release.releaseId);
		if (release.parentAgentId !== parentAgentId) {
			throw new Error(
				`completion delivery release ${release.releaseId} belongs to another parent`,
			);
		}
		for (const deliveryId of release.deliveryIds) {
			const deliveryItem = deliveries.find(
				(item) => item.delivery.deliveryId === deliveryId,
			);
			if (!deliveryItem || deliveryItem.index >= releaseIndex) {
				throw new Error(
					`completion delivery release ${release.releaseId} references unavailable delivery ${deliveryId}`,
				);
			}
			const delivery = deliveryItem.delivery;
			if (delivery.runtimeId !== release.runtimeId) {
				throw new Error(
					`completion delivery release ${release.releaseId} has a mismatched runtime`,
				);
			}
			releasedDeliveryIds.add(deliveryId);
		}
	}

	const unread = [...updates];
	for (const item of deliveries) {
		if (
			!item.committed
			|| releasedDeliveryIds.has(item.delivery.deliveryId)
		) {
			continue;
		}
		if (item.delivery.completionIds.length > unread.length) {
			throw new Error(
				`completion delivery ${item.delivery.deliveryId} exceeds the unread FIFO`,
			);
		}
		for (
			let index = 0;
			index < item.delivery.completionIds.length;
			index++
		) {
			const completionId = item.delivery.completionIds[index]!;
			if (completionId !== unread[index]?.completionId) {
				throw new Error(
					`completion delivery ${item.delivery.deliveryId} is not the unread FIFO prefix`,
				);
			}
		}
		unread.splice(0, item.delivery.completionIds.length);
	}

	const currentRuntimeReservations = deliveries
		.filter(
			(item) =>
				!item.committed
				&& !releasedDeliveryIds.has(item.delivery.deliveryId)
				&& activeRuntimeId !== undefined
				&& item.delivery.runtimeId === activeRuntimeId,
		)
		.map((item) => ({
			...item.delivery,
			completionIds: [...item.delivery.completionIds],
		}));
	const reserved = new Set(
		currentRuntimeReservations.flatMap(
			(delivery) => delivery.completionIds,
		),
	);
	return {
		updates: updates.map((update) => ({ ...update })),
		unread: unread.map((update) => ({ ...update })),
		available: unread
			.filter((update) => !reserved.has(update.completionId))
			.map((update) => ({ ...update })),
		currentRuntimeReservations,
	};
}

export function foldCompletionMailbox(
	entries: readonly SessionEntry[],
	options: {
		parentAgentId: string;
		activeRuntimeId?: string;
	},
): CompletionMailboxFold {
	try {
		return {
			kind: "valid",
			snapshot: foldOrThrow(
				entries,
				options.parentAgentId,
				options.activeRuntimeId,
			),
		};
	} catch (error) {
		return {
			kind: "corrupt",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

export function readCompletionMailbox(
	entries: readonly SessionEntry[],
	options: {
		parentAgentId: string;
		activeRuntimeId?: string;
	},
): CompletionMailboxSnapshot {
	const folded = foldCompletionMailbox(entries, options);
	if (folded.kind === "corrupt") {
		throw new Error(`corrupt completion mailbox: ${folded.message}`);
	}
	return folded.snapshot;
}

export function appendCompletionUpdate(
	session: SessionView,
	input: {
		parentAgentId: string;
		childAgentId: string;
		result: SubagentRunResult;
	},
): CompletionUpdate {
	const snapshot = readCompletionMailbox(session.getEntries(), {
		parentAgentId: input.parentAgentId,
	});
	const existing = snapshot.updates.find(
		(update) =>
			update.childAgentId === input.childAgentId
			&& update.turnId === input.result.turnId,
	);
	if (existing) return { ...existing };
	const update = parseUpdate({
		version: COMPLETION_MAILBOX_VERSION,
		completionId: uuidv7(),
		parentAgentId: input.parentAgentId,
		childAgentId: input.childAgentId,
		turnId: input.result.turnId,
		stopReason: input.result.stopReason,
		output: input.result.output,
		outputTruncated: input.result.outputTruncated ?? false,
		...(input.result.omittedBytes !== undefined
			? { omittedBytes: input.result.omittedBytes }
			: {}),
		createdAt: new Date().toISOString(),
	});
	session.appendCustomEntry(COMPLETION_UPDATE_CUSTOM_TYPE, update);
	return update;
}

export function reserveCompletionDelivery(
	session: SessionView,
	input: {
		parentAgentId: string;
		runtimeId: string;
		toolCallId: string;
		completionIds: readonly string[];
	},
): CompletionDelivery {
	const snapshot = readCompletionMailbox(session.getEntries(), {
		parentAgentId: input.parentAgentId,
		activeRuntimeId: input.runtimeId,
	});
	if (snapshot.currentRuntimeReservations.length > 0) {
		throw new Error(
			"a previous wait_agent delivery is awaiting its durable tool result",
		);
	}
	if (
		input.completionIds.length === 0
		|| input.completionIds.length > snapshot.available.length
	) {
		throw new Error("completion delivery batch is no longer available");
	}
	for (let index = 0; index < input.completionIds.length; index++) {
		if (
			input.completionIds[index]
				!== snapshot.available[index]?.completionId
		) {
			throw new Error(
				"completion delivery batch is no longer the available FIFO prefix",
			);
		}
	}
	const delivery = parseDelivery({
		version: COMPLETION_MAILBOX_VERSION,
		deliveryId: uuidv7(),
		runtimeId: input.runtimeId,
		parentAgentId: input.parentAgentId,
		toolCallId: input.toolCallId,
		completionIds: [...input.completionIds],
		createdAt: new Date().toISOString(),
	});
	session.appendCustomEntry(
		COMPLETION_DELIVERY_CUSTOM_TYPE,
		delivery,
	);
	return delivery;
}

export function releaseCompletionDeliveries(
	session: SessionView,
	input: {
		parentAgentId: string;
		runtimeId: string;
		reason: string;
	},
): number {
	const snapshot = readCompletionMailbox(session.getEntries(), {
		parentAgentId: input.parentAgentId,
		activeRuntimeId: input.runtimeId,
	});
	if (snapshot.currentRuntimeReservations.length === 0) return 0;
	const release = parseDeliveryRelease({
		version: COMPLETION_MAILBOX_VERSION,
		releaseId: uuidv7(),
		runtimeId: input.runtimeId,
		parentAgentId: input.parentAgentId,
		deliveryIds: snapshot.currentRuntimeReservations.map(
			(delivery) => delivery.deliveryId,
		),
		reason: input.reason,
		createdAt: new Date().toISOString(),
	});
	session.appendCustomEntry(
		COMPLETION_DELIVERY_RELEASE_CUSTOM_TYPE,
		release,
	);
	return release.deliveryIds.length;
}

export function appendUndeliveredCompletion(
	session: SessionView,
	input: {
		parentAgentId: string;
		childAgentId: string;
		result: SubagentRunResult;
		error: string;
	},
): void {
	session.appendCustomEntry(COMPLETION_FAILURE_CUSTOM_TYPE, {
		version: COMPLETION_MAILBOX_VERSION,
		parentAgentId: input.parentAgentId,
		childAgentId: input.childAgentId,
		turnId: input.result.turnId,
		stopReason: input.result.stopReason,
		output: input.result.output,
		outputTruncated: input.result.outputTruncated ?? false,
		...(input.result.omittedBytes !== undefined
			? { omittedBytes: input.result.omittedBytes }
			: {}),
		error: input.error.slice(0, 4000),
		createdAt: new Date().toISOString(),
	});
}

export function unreadCompletionCounts(
	snapshot: CompletionMailboxSnapshot,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const update of snapshot.unread) {
		counts.set(
			update.childAgentId,
			(counts.get(update.childAgentId) ?? 0) + 1,
		);
	}
	return counts;
}
