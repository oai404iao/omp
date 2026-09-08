export function themeFg(theme: any, token: string, text: string): string {
	try { return theme?.fg?.(token, text) ?? text; } catch { return text; }
}

export function themeBold(theme: any, text: string): string {
	try { return theme?.bold?.(text) ?? text; } catch { return text; }
}
