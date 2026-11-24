type ResultWithDetails = { details: object; isError?: boolean };

export async function executeWithToolResult<T extends ResultWithDetails>(
	signal: AbortSignal | undefined,
	execute: () => Promise<T>,
	formatError: (message: string) => string = message => message,
) {
	try {
		const result = await execute();
		const isError = result.isError === true;
		return { ...result, isError, details: { ...result.details, success: !isError } };
	} catch (error) {
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: formatError(message) }],
			isError: true as const,
			details: { success: false as const },
		};
	}
}
