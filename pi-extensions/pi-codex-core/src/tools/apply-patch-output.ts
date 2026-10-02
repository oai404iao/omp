export const applyPatchOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["summary", "files"],
	properties: {
		summary: { type: "string" },
		files: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["kind", "path", "absolutePath"],
				properties: {
					kind: { type: "string", enum: ["add", "update", "delete"] },
					path: { type: "string" },
					absolutePath: { type: "string" },
					moveTo: { type: "string" },
					absoluteMoveTo: { type: "string" },
				},
			},
		},
	},
};
