export class ScriptFailure extends Error {}
export class UnsupportedOutput extends Error {}
export class RuntimeResetError extends Error {
	constructor(message: string, readonly kind: "script" | "unsupported-output" | "runtime") {
		super(`${message}\nRuntime reset; JSON store lost. External side effects are not rolled back.`);
	}
}
export class UnconfirmedRuntimeStop extends RuntimeResetError {
	constructor(message: string) { super(`Host stop unconfirmed: ${message}`, "runtime"); }
}
