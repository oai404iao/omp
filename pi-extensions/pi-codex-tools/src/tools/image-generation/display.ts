import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeCachedImagePreview, renderImageGenerationMessage } from "./preview.js";
import { buildGeneratedImageDisplayText } from "./storage.js";
import {
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	type CachedImagePreview,
	type ImageDisplayMessageDetails,
	type PendingActivity,
	type SavedGeneratedImage,
} from "./types.js";

export function createImageDisplay(pi: ExtensionAPI) {
	const pendingActivities: PendingActivity[] = [];
	const imagePreviewCache = new Map<string, CachedImagePreview>();
	let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;

	const cancelFlush = () => {
		if (pendingFlushTimer !== undefined) clearTimeout(pendingFlushTimer);
		pendingFlushTimer = undefined;
	};

	const flush = () => {
		cancelFlush();
		const activities = pendingActivities.splice(0, pendingActivities.length);
		for (const activity of activities) {
			imagePreviewCache.set(activity.savedImage.absolutePath, makeCachedImagePreview(activity.imageData.data, activity.imageData.mimeType));
			pi.sendMessage(
				{
					customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
					content: [{ type: "text", text: buildGeneratedImageDisplayText(activity.savedImage, { expanded: false }) }],
					display: true,
					details: { savedImages: [activity.savedImage] } satisfies ImageDisplayMessageDetails,
				},
				{ triggerTurn: false },
			);
		}
	};

	return {
		flush,
		scheduleFlush() {
			if (pendingFlushTimer !== undefined || pendingActivities.length === 0) return;
			pendingFlushTimer = setTimeout(flush, 0);
		},
		clear() {
			generation++;
			cancelFlush();
			pendingActivities.length = 0;
			imagePreviewCache.clear();
		},
		/** Ignore completion callbacks belonging to a replaced/closed session. */
		captureSink() {
			const requestGeneration = generation;
			return (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => {
				if (requestGeneration !== generation) return;
				pendingActivities.push({ kind: "image", savedImage, imageData });
			};
		},
		registerRenderer() {
			pi.registerMessageRenderer<ImageDisplayMessageDetails>(IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, options, theme) => {
				const savedImage = message.details?.savedImages?.[0];
				const textContent = typeof message.content === "string"
					? message.content
					: message.content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n");
				return renderImageGenerationMessage(savedImage, textContent, options, theme, imagePreviewCache);
			});
		},
	};
}
