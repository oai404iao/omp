export type FixtureCall = { name: string; args?: Record<string, unknown>; input?: string };
export function grammarResponse(api: string, call?: FixtureCall, id = "fixture"): Response {
	const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
	let text: string;
	if (api === "anthropic-messages") {
		const send = (type: string, body: object) => `event: ${type}\n${event({ type, ...body })}`;
		text = send("message_start", { message: { id, type: "message", role: "assistant", model: "s1", content: [],
			stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
			+ send("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
			+ send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Done" } })
			+ send("content_block_stop", { index: 0 })
			+ send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
			+ send("message_stop", {});
	} else if (api === "openai-completions") {
		const chunk = (delta: unknown, finish_reason: string | null) => event({
			id, object: "chat.completion.chunk", created: 1, model: "s1", choices: [{ index: 0, delta, finish_reason }],
		});
		text = chunk(call ? { role: "assistant", tool_calls: [{ index: 0, id, ...(call.input !== undefined
			? { type: "custom", custom: { name: call.name, input: call.input } }
			: { type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }) }] }
			: { role: "assistant", content: "Done" }, null)
			+ chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n";
	} else {
		const item = call ? call.input !== undefined
			? { type: "custom_tool_call", id: `ctc_${id}`, call_id: id, name: call.name, input: call.input }
			: { type: "function_call", id: `fc_${id}`, call_id: id, name: call.name, arguments: JSON.stringify(call.args ?? {}) }
			: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
				content: [{ type: "output_text", text: "Done", annotations: [] }] };
		const values: unknown[] = [
			{ type: "response.created", response: { id: `resp_${id}` } },
			{ type: "response.output_item.added", output_index: 0, item: call
				? call.input !== undefined ? { ...item, input: "" } : { ...item, arguments: "" }
				: { ...item, content: [] } },
		];
		if (call?.input !== undefined) {
			values.push({ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: item.id, delta: call.input.slice(0, 11) },
				{ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: item.id, delta: call.input.slice(11) },
				{ type: "response.custom_tool_call_input.done", output_index: 0, item_id: item.id, input: call.input });
		} else if (call) {
			values.push({ type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(call.args ?? {}) });
		} else values.push({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done" });
		values.push({ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
		text = values.map((value, sequence_number) => event({ ...(value as object), sequence_number })).join("");
	}
	return new Response(text, { headers: { "content-type": "text/event-stream" } });
}
export function wireTools(body: Record<string, unknown>): Record<string, unknown>[] {
	if (Array.isArray(body.tools)) return body.tools;
	const additional = (body.input as Record<string, unknown>[] | undefined)?.find((item) => item.type === "additional_tools");
	return ((additional?.tools ?? []) as Record<string, unknown>[]).flatMap((item) =>
		item.type === "namespace" ? item.tools as Record<string, unknown>[] : [item]);
}
