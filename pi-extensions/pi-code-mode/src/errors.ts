export class ScriptFailure extends Error {}
export class UnsupportedOutput extends Error {}
export class UnsettledEffect extends Error {
	readonly code = "PI_CODE_MODE_UNSETTLED_EFFECT";
	readonly version = 1;
	constructor(message: string) { super(message.slice(0, 2000)); }
}
export function unsettledEffect(message = "Owner cannot confirm that tool effects have stopped"): UnsettledEffect {
	return new UnsettledEffect(message.slice(0, 2000));
}
export function isUnsettledEffect(value: unknown): value is Error & { code: string; version: 1 } {
	if (!value || typeof value !== "object") return false;
	const error = value as Record<string, unknown>;
	return error.code === "PI_CODE_MODE_UNSETTLED_EFFECT" && error.version === 1
		&& typeof error.message === "string";
}
export class RuntimeResetError extends Error {
	constructor(message: string, readonly kind: "script" | "unsupported-output" | "runtime") {
		super(`${message}\nRuntime reset; JSON store lost. External side effects are not rolled back.`);
	}
}
export class UnconfirmedRuntimeStop extends RuntimeResetError {
	constructor(message: string) { super(`Host stop unconfirmed: ${message}`, "runtime"); }
}
