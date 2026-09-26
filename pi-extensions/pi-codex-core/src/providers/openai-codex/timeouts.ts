export function timeoutFromOption(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}: ${value}`);
	return Math.floor(value);
}
