export const ROOT_TASK_PATH = "/root";

export function validateTaskName(name: string): string {
	if (!/^[a-z0-9_]{1,64}$/.test(name) || name === "root") {
		throw new Error("task_name must be 1–64 lowercase ASCII letters, digits or underscores; 'root' is reserved");
	}
	return name;
}

function canonical(path: string): string {
	if (path === ROOT_TASK_PATH) return path;
	if (!path.startsWith(`${ROOT_TASK_PATH}/`)) throw new Error("agent path must be in /root");
	for (const segment of path.slice(ROOT_TASK_PATH.length + 1).split("/")) validateTaskName(segment);
	return path;
}

export function taskPath(parent: string, name: string): string {
	return `${canonical(parent)}/${validateTaskName(name)}`;
}

export function resolveTaskPath(caller: string, reference: string): string {
	canonical(caller);
	if (!reference) throw new Error("agent path must not be empty");
	return canonical(reference.startsWith("/") ? reference : `${caller}/${reference}`);
}

export function pathMatches(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}
