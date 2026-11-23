export const ratings = ["good", "bad"] as const;

interface Feedback {
	feedback: (typeof ratings)[number];
	description?: string;
}

export interface FeedbackRecord extends Feedback {
	id: string;
	createdAt: string;
	sessionId: string;
	userMessageEntryId: string;
	finalAssistantEntryId: string | null;
	projectPath: string;
}

export function feedbackInput(rating: string, description: string): Feedback | undefined {
	const feedback = ratings.find(value => value === rating);
	if (!feedback) return undefined;
	const text = description.trim();
	return text ? { feedback, description: text } : { feedback };
}

export function parseFeedback(args: string): Feedback | undefined {
	const text = args.trim();
	const [rating] = text.split(/\s/, 1);
	return feedbackInput(rating, text.slice(rating.length));
}
