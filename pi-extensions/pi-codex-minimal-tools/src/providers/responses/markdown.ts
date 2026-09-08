interface MarkdownCodeRange {
	start: number;
	end: number;
}

function characterRunLength(text: string, index: number, character: string): number {
	let end = index;
	while (end < text.length && text[end] === character) end++;
	return end - index;
}

function isFencePosition(text: string, index: number): boolean {
	const lineStart = text.lastIndexOf("\n", index - 1) + 1;
	return /^ {0,3}$/.test(text.slice(lineStart, index));
}

export function markdownCodeRanges(text: string): MarkdownCodeRange[] {
	const ranges: MarkdownCodeRange[] = [];
	let fence: { character: "`" | "~"; length: number; start: number } | undefined;
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (fence) {
			if (character === fence.character && isFencePosition(text, index)) {
				const runLength = characterRunLength(text, index, character);
				if (runLength >= fence.length) {
					ranges.push({ start: fence.start, end: index + runLength });
					fence = undefined;
					index += runLength;
					continue;
				}
			}
			index++;
			continue;
		}

		if ((character === "`" || character === "~") && isFencePosition(text, index)) {
			const runLength = characterRunLength(text, index, character);
			if (runLength >= 3) {
				fence = { character, length: runLength, start: index };
				index += runLength;
				continue;
			}
		}

		if (character === "`") {
			const runLength = characterRunLength(text, index, character);
			const delimiter = character.repeat(runLength);
			const close = text.indexOf(delimiter, index + runLength);
			if (close < 0) {
				ranges.push({ start: index, end: text.length });
				break;
			}
			ranges.push({ start: index, end: close + runLength });
			index = close + runLength;
			continue;
		}
		index++;
	}
	if (fence) ranges.push({ start: fence.start, end: text.length });
	return ranges;
}

export function isInsideMarkdownCode(index: number, ranges: MarkdownCodeRange[]): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

export function trailingCitationFragmentStart(text: string, ranges: MarkdownCodeRange[]): number | undefined {
	const opener = "cite";
	const openIndex = text.lastIndexOf("cite");
	if (openIndex >= 0 && text.indexOf("", openIndex) < 0 && !isInsideMarkdownCode(openIndex, ranges)) {
		return openIndex;
	}
	for (let length = Math.min(opener.length - 1, text.length); length > 0; length--) {
		if (!text.endsWith(opener.slice(0, length))) continue;
		const start = text.length - length;
		if (!isInsideMarkdownCode(start, ranges)) return start;
	}
	return undefined;
}

export function trailingIndexedSourceFragmentStart(text: string, ranges: MarkdownCodeRange[]): number | undefined {
	const openIndex = text.lastIndexOf("【");
	if (openIndex < 0 || text.indexOf("】", openIndex) >= 0 || isInsideMarkdownCode(openIndex, ranges)) {
		return undefined;
	}
	const fragment = text.slice(openIndex);
	const match = /^【\d*(?:†([a-z]*))?$/i.exec(fragment);
	if (!match) return undefined;
	const sourceFragment = match[1]?.toLowerCase() ?? "";
	return "source".startsWith(sourceFragment) ? openIndex : undefined;
}
