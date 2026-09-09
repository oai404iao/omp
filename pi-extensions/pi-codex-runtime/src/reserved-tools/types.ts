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

export type CodexReservedToolName = "web_search" | "image_generation";

export interface CodexReservedNamespaceTool {
	type: "namespace";
	name: "web" | "image_gen";
	description: string;
	tools: Array<{
		type: "function";
		name: "run" | "imagegen";
		description: string;
		strict: false;
		parameters: Record<string, unknown>;
	}>;
}
