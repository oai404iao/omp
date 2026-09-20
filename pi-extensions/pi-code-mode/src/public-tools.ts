import { Type } from "typebox";
import type { Observation } from "./cell.ts";
import { LIMITS } from "./limits.ts";

export const execParameters = Type.Object({
	code: Type.String({ minLength: 1, maxLength: LIMITS.codeBytes }),
	yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: LIMITS.observeMs })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.executionMs })),
	max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
}, { additionalProperties: false });
export const waitParameters = Type.Object({
	cell_id: Type.String({ minLength: 1, maxLength: 128 }),
	yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: LIMITS.observeMs })),
	max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
	terminate: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const EXEC_DESCRIPTION = `Execute JavaScript to orchestrate ONLY the explicitly authorized nested tools described below.
This is not Node: no fs/network/process/import/console APIs. Use tools.NAME(args), await/Promise.all, and text(value).
Only text(value) emits business output; a JS return value does not. TypeScript-style tool signatures below are display hints, not executable TS or a replacement for runtime schema constraints. Undeclared return schemas mean unknown.
ALL_TOOLS lists enabled {name,description} metadata, not ungranted tools. Empty object arguments may be omitted. setTimeout/clearTimeout exist; await a promise to keep timer work alive. yield_control() flushes Host output for a subsequent observation but does not extend the deadline or finish the cell. exit() ends the script successfully; await effects before calling it.
exec({code,yield_time_ms?,timeout_ms?,max_tokens?}) starts one cell. Default capacity is 1; explicit user configuration may allow up to 4 cells sharing one Host. Terminal unread output/traces/usage still occupy a slot. It waits up to yield_time_ms (default 1000, max 30000), then returns a cell_id if still running. Use wait to observe/terminate; never restart or replay code to poll.
timeout_ms is the TOTAL cell lifetime, default/max 300000ms; wait does not extend it. At most 32 calls per cell; ALL cells share 4 workers and 16 queued jobs. Writes/process/unknown concurrency are exclusive across all Code Mode cells, not arbitrary direct Pi tools.
24 KiB code, 32 KiB TOTAL emitted text, 1 MiB IPC frames. max_tokens is an approximate data-output budget (4 UTF-8 bytes/token, max 8192), not exact tokenization. Excess buffered text stays available via wait.
Each cell has fresh JS globals. JSON store(key,value)/load(key) persists within this volatile shared Host: per-cell snapshots, written keys merge on completion; same-key last actual commit wins, not a transaction. Completed cells commit store, terminated cells discard pending writes. Normal termination targets one cell; failures/OOM/hard watchdog/model/tree/reload/off can reset ALL siblings and store. Check load() before use.
Nested tools DO NOT invoke Pi's current tools or inherit Pi tool_call/tool_result permissions/redaction. Only separately granted capabilities are available.
Explicit approval providers may pause calls in awaiting_approval. Positive-yield exec/wait holds for a pending approval until it closes or the cell is cancelled; zero-yield stays nonblocking. Never bypass/re-execute a pending approval.
Await every side-effecting call. Cancellation does not roll back writes, external requests, or remote/escaped processes. A terminating/settling result does not confirm effects stopped.
Only text output; image/audio/notify unsupported. Keep Pi control-flow/dynamic-loader tools direct. Unadapted direct tools remain available; cooperating counterparts may be hidden.`;
export const WAIT_DESCRIPTION = `Observe or terminate an existing Code Mode cell by its exact cell_id.
wait({cell_id,yield_time_ms?,max_tokens?,terminate?}) waits up to 1000ms by default (max 30000). It never re-executes code or extends the cell deadline.
terminate requests cancellation; keep waiting if state is terminating/settling. Only terminal state confirms the cell finished; effectsUnsettled explicitly means cleanup is NOT confirmed.
One observer per cell; different cells may be observed independently. Collect all buffered output/traces and usage to release a slot (default 1; user-configured up to 4). Unknown/consumed/old-session ids fail; results are never replayed.
Positive-yield observations hold for outstanding explicit approvals until approval/cancellation; awaiting_approval is not a reason to replay or bypass the call.
max_tokens budgets emitted data at 4 UTF-8 bytes/token, not exact tokens. Termination cannot undo external side effects.`;

export function renderObservation(value: Observation) {
	const pending = !["completed", "terminated", "failed"].includes(value.state);
	const lines = [`[Code Mode ${value.cellId}: ${value.state}; ${value.calls} calls]`];
	if (value.fresh) lines.push(`[New runtime ${value.epoch}; previous Host store is unavailable.]`);
	if (value.text) lines.push(value.text);
	if (value.truncated) lines.push(`[Output truncated: ${value.droppedBytes} bytes discarded, not available through wait. ${value.hostCompleted ? "Host already completed; store writes may have committed." : "Cell stop requested."}]`);
	if (value.runtimeReset) lines.push("[Runtime reset; volatile store lost.]");
	if (value.traces.length) lines.push(`[Nested updates: ${value.traces.map((trace) => `${trace.id} ${trace.name} ${trace.state}`).join("; ")}]`);
	if (value.observerFailures) lines.push(`[${value.observerFailures} diagnostic observer failures; business result unchanged.]`);
	if (value.error) lines.push(value.error);
	if (pending || value.hasMoreOutput || value.hasMoreTraces) lines.push(`Use wait({cell_id:${JSON.stringify(value.cellId)}}) to collect ${value.hasMoreOutput || value.hasMoreTraces ? "remaining buffered output/trace updates" : "completion"}. Do not rerun exec.`);
	if (value.effectsUnsettled) lines.push("STOP UNCONFIRMED: Code Mode is blocked; external side effects may still be running.");
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: { brand: "pi-code-mode/v2", ...value, text: undefined, usage: undefined },
		...(value.usage ? { usage: value.usage } : {}),
	};
}
