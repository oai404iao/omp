/*
 * SPDX-FileCopyrightText: 2025 OpenAI
 * SPDX-FileCopyrightText: 2026 oai404iao
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified TypeScript compatibility serialization derived from the namespace
 * tool construction in OpenAI Codex at revisions
 * 5a3140176e668a2f72f3c098490eb7f7052d9d85 and
 * a1604a8c0554c09c1be45e5a121bb1889b4d9a50.
 *
 * This preserves the reviewed `web.run` and `image_gen.imagegen` declaration
 * shapes for this package's internal Responses Lite compatibility path. It is
 * not an OpenAI-supported public API contract. Immutable upstream blob IDs,
 * source hashes, and current compatibility fingerprints are recorded in
 * provenance/openai-codex-a1604a8c-tool-declarations.json.
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
				description: `This tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:

- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.
- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).

Guidelines:
- Image generation can take a few minutes. In Pi codemode, use \`const result = await tools.image_generation(args); image(result.image);\`. Avoid setting a short script timeout.
- Do not print the full result or its base64 image data with \`text()\`, \`console\`, or \`return\`. Print only small metadata, such as \`result.path\`, when needed.
- Set \`transparent_background\` to true when the request calls for a transparent background, including background removal or a cutout; set it to false otherwise. For edits, preserve existing transparency unless the user asks to change it.
- Omit both \`referenced_image_paths\` and \`num_last_images_to_include\` when generating a brand new image.
- For edits, use \`referenced_image_paths\` when every target image has a local file path.
- If you have not seen a local image yet and Pi's \`read\` tool is available, inspect it before editing. Use \`read\` directly if declared, or \`tools.read\` in Pi codemode when callable.
- Use \`num_last_images_to_include\` only when at least one target image has no local file path.
- Set \`num_last_images_to_include\` to the smallest number of recent conversation images that includes every target image, up to 5.
- Never provide both \`referenced_image_paths\` and \`num_last_images_to_include\`.
- If neither mechanism can include every target image, ask the user to attach the missing images again.
- Directly generate the image without reconfirmation or clarification unless required images must be attached again.
- Always use this tool for image editing unless the user explicitly requests otherwise. Do not use Python for image editing unless specifically instructed.
`,
				strict: false,
				parameters: {
					type: "object",
					properties: {
						num_last_images_to_include: {
							type: ["integer", "null"],
							minimum: 1,
							maximum: 5,
							description: "Use the newest conversation images when at least one target has no local file path.",
						},
						prompt: {
							type: "string",
							description: "Image generation or editing prompt.",
						},
						referenced_image_paths: {
							type: ["array", "null"],
							maxItems: 5,
							description: "Local image paths to edit, relative to the working directory or absolute. PNG, JPEG, WebP, GIF, and BMP are supported.",
							items: {
								type: "string",
								minLength: 1,
							},
						},
						transparent_background: {
							type: "boolean",
							description: "Whether the output should have a transparent background. Defaults to false.",
						},
					},
					required: ["prompt"],
					additionalProperties: false,
				},
			},
		],
	};
