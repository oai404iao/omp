export const IMAGE_SAVE_DISPLAY_MESSAGE_TYPE = "codex-image-generation-display";

export interface SavedGeneratedImage {
	absolutePath: string;
	relativePath: string;
	latestAbsolutePath: string;
	latestRelativePath: string;
	responseId: string | undefined;
	callId: string;
	outputFormat: string;
	imageModel?: string;
	revisedPrompt?: string;
}

export interface ImageDisplayMessageDetails {
	savedImages: SavedGeneratedImage[];
}

interface PendingImageDisplay {
	savedImage: SavedGeneratedImage;
	imageData: { data: string; mimeType: string };
}

interface QueuedImageActivity extends PendingImageDisplay {
	kind: "image";
}

export type PendingActivity = QueuedImageActivity;

export interface CachedImagePreview {
	data: string;
	mimeType: string;
	bytes: number;
	widthPx?: number;
	heightPx?: number;
}
