/*
 * SPDX-FileCopyrightText: 2025 OpenAI
 * SPDX-FileCopyrightText: 2026 oai404iao
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified TypeScript compatibility serialization derived from the namespace
 * tool construction in OpenAI Codex at revision
 * eb9dceba1a2e658142a456c5898836774835616b.
 *
 * This preserves the reviewed `web.run` and `image_gen.imagegen` declaration
 * shapes for this package's internal Responses Lite compatibility path. It is
 * not an OpenAI-supported public API contract. Immutable upstream blob IDs,
 * source hashes, and local compatibility fingerprints are recorded in
 * provenance/openai-codex-eb9dceba-reserved-tools.json.
 *
 * See THIRD_PARTY_NOTICES.md and LICENSES/Apache-2.0.txt.
 */

import type { CodexReservedNamespaceTool } from "./types.js";

export const IMAGE_GENERATION_NAMESPACE: CodexReservedNamespaceTool = {
		type: "namespace",
		name: "image_gen",
		description: "Tools in the image_gen namespace.",
		tools: [
			{
				type: "function",
				name: "imagegen",
				description: "The `image_gen.imagegen` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:\n\n- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.\n- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).\n\nGuidelines:\n- imagegen needs a few minutes to finish. In code-mode, use the first-line @exec directive to give the initial call 120 seconds and the same yield for any waits that follow. Once it finishes, return the image with generatedImage(result).\n- Omit both `referenced_image_paths` and `num_last_images_to_include` when generating a brand new image.\n- For edits, use `referenced_image_paths` when every target image has a local file path.\n- If you have not seen a local image yet, use `view_image` to inspect it before editing.\n- Use `num_last_images_to_include` only when at least one target image has no local file path.\n- Set `num_last_images_to_include` to the smallest number of recent conversation images that includes every target image, up to 5.\n- Never provide both `referenced_image_paths` and `num_last_images_to_include`.\n- If neither mechanism can include every target image, ask the user to attach the missing images again.\n- Directly generate the image without reconfirmation or clarification unless required images must be attached again.\n- Always use this tool for image editing unless the user explicitly requests otherwise. Do not use the `python` tool for image editing unless specifically instructed.\n",
				strict: false,
				parameters: {
					type: "object",
					properties: {
						num_last_images_to_include: {
							type: ["integer", "null"],
						},
						prompt: {
							type: "string",
						},
						referenced_image_paths: {
							type: ["array", "null"],
							items: {
								type: "string",
								description: "A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).\n\nIMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.",
							},
						},
					},
					required: ["prompt"],
					additionalProperties: false,
				},
			},
		],
	};
