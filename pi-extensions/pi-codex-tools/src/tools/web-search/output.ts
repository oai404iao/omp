export const webSearchOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["output", "results"],
	properties: {
		output: { type: "string", description: "Full search output, including citation references." },
		results: { type: "array", items: {}, description: "Backend result metadata, when available." },
	},
};
