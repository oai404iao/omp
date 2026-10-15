import type { SavedImageInfo } from "../../utils/images.js";

export const imageGenerationOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["path", "image"],
	properties: {
		path: { type: "string" },
		latestPath: { type: "string" },
		image: {
			type: "object",
			additionalProperties: false,
			required: ["type", "data", "mimeType"],
			properties: {
				type: { type: "string", const: "image" },
				data: { type: "string", description: "Base64 image data. Use image(result.image) to show it to the model." },
				mimeType: { type: "string" },
			},
		},
	},
};

export function imageGenerationOutput(saved: SavedImageInfo, base64: string) {
	return {
		path: saved.path,
		...(saved.latestPath ? { latestPath: saved.latestPath } : {}),
		image: { type: "image" as const, data: base64, mimeType: saved.mimeType },
	};
}
