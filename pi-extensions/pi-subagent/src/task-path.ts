import type {
	SubagentDescriptor,
	SubagentTask,
} from "./types.ts";

export const ROOT_TASK_PATH = "/root";
export const LEGACY_TASK_NAMESPACE = ".legacy";
export const MAX_TASK_NAME_LENGTH = 64;
export const MAX_TASK_PATH_LENGTH = 4096;

const TASK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pathSegments(path: string): string[] {
	if (path.length > MAX_TASK_PATH_LENGTH) {
		throw new Error(
			`task path exceeds ${MAX_TASK_PATH_LENGTH} characters`,
		);
	}
	if (!path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
		throw new Error(`task path must be a canonical absolute path under ${ROOT_TASK_PATH}`);
	}
	const segments = path.slice(1).split("/");
	if (segments[0] !== "root") {
		throw new Error(`task path must be rooted at ${ROOT_TASK_PATH}`);
	}
	return segments;
}

export function validateTaskName(value: string): string {
	if (!TASK_NAME_PATTERN.test(value)) {
		throw new Error(
			"task_name must contain 1-64 lowercase ASCII letters, digits, hyphens, or underscores and start with a letter or digit",
		);
	}
	if (value === "root" || value === LEGACY_TASK_NAMESPACE) {
		throw new Error(`task_name "${value}" is reserved`);
	}
	return value;
}

export function validateTaskPath(path: string): string {
	if (path === ROOT_TASK_PATH) return path;
	const segments = pathSegments(path);
	for (let index = 1; index < segments.length; index++) {
		const segment = segments[index]!;
		if (
			index === 1
			&& segment === LEGACY_TASK_NAMESPACE
		) {
			const legacyId = segments[index + 1];
			if (!legacyId || !AGENT_ID_PATTERN.test(legacyId)) {
				throw new Error(
					`legacy task paths must use ${ROOT_TASK_PATH}/${LEGACY_TASK_NAMESPACE}/<agent-id>`,
				);
			}
			index++;
			continue;
		}
		validateTaskName(segment);
	}
	return path;
}

export function taskPath(parentPath: string, name: string): string {
	validateTaskPath(parentPath);
	validateTaskName(name);
	const path = `${parentPath}/${name}`;
	return validateTaskPath(path);
}

export function legacyTaskPath(agentId: string): string {
	if (!AGENT_ID_PATTERN.test(agentId)) {
		throw new Error("legacy task path requires a UUIDv7 agent id");
	}
	return `${ROOT_TASK_PATH}/${LEGACY_TASK_NAMESPACE}/${agentId}`;
}

export function descriptorTaskPath(
	descriptor: SubagentDescriptor,
): string {
	return descriptor.version === 3
		? descriptor.task.path
		: legacyTaskPath(descriptor.agentId);
}

export function descriptorTask(
	descriptor: SubagentDescriptor,
): SubagentTask {
	if (descriptor.version === 3) return { ...descriptor.task };
	return {
		name: descriptor.agentId,
		path: legacyTaskPath(descriptor.agentId),
	};
}

export function validateDescriptorTask(task: SubagentTask): SubagentTask {
	const name = validateTaskName(task.name);
	const path = validateTaskPath(task.path);
	if (path === ROOT_TASK_PATH || path.split("/").at(-1) !== name) {
		throw new Error("task.path must end with task.name");
	}
	return { name, path };
}

export function slugTaskName(value: string): string {
	const normalized = value
		.normalize("NFKD")
		.replace(/\p{Mark}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/[-_]{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, MAX_TASK_NAME_LENGTH)
		.replace(/[-_]+$/g, "");
	const candidate =
		!normalized || normalized === "root" || normalized === LEGACY_TASK_NAMESPACE
			? "task"
			: normalized;
	return validateTaskName(candidate);
}

export function numberedTaskName(base: string, ordinal: number): string {
	validateTaskName(base);
	if (!Number.isSafeInteger(ordinal) || ordinal < 2) {
		throw new Error("task name ordinal must be an integer of at least 2");
	}
	const suffix = `-${ordinal}`;
	const prefix = base
		.slice(0, MAX_TASK_NAME_LENGTH - suffix.length)
		.replace(/[-_]+$/g, "");
	return validateTaskName(`${prefix || "task"}${suffix}`);
}

export function resolveTaskPath(
	basePath: string,
	reference: string,
): string {
	validateTaskPath(basePath);
	if (!reference.trim() || reference !== reference.trim()) {
		throw new Error("task path reference must be a non-empty trimmed string");
	}
	if (reference.length > MAX_TASK_PATH_LENGTH) {
		throw new Error(
			`task path reference exceeds ${MAX_TASK_PATH_LENGTH} characters`,
		);
	}
	if (reference.includes("//") || (reference.length > 1 && reference.endsWith("/"))) {
		throw new Error("task path reference contains an empty segment");
	}

	const absolute = reference.startsWith("/");
	const segments = absolute ? ["root"] : pathSegments(basePath);
	const input = absolute ? reference.slice(1).split("/") : reference.split("/");
	if (absolute && input.shift() !== "root") {
		throw new Error(`absolute task paths must be rooted at ${ROOT_TASK_PATH}`);
	}
	for (const segment of input) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 1) {
				throw new Error(`task path reference cannot escape ${ROOT_TASK_PATH}`);
			}
			segments.pop();
			continue;
		}
		if (segment === LEGACY_TASK_NAMESPACE) {
			segments.push(segment);
			continue;
		}
		if (
			segments.at(-1) === LEGACY_TASK_NAMESPACE
			&& AGENT_ID_PATTERN.test(segment)
		) {
			segments.push(segment);
			continue;
		}
		validateTaskName(segment);
		segments.push(segment);
	}
	const resolved = `/${segments.join("/")}`;
	return validateTaskPath(resolved);
}

export function isAgentId(value: string): boolean {
	return AGENT_ID_PATTERN.test(value);
}
