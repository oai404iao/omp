function keyText(keybinding: string): string {
	return keybinding === "app.tools.expand" ? "ctrl+o" : "";
}

export const renderKeybindings = {
	keyText,
	keyHint(keybinding: string, description: string): string {
		return [keyText(keybinding), description].filter(Boolean).join(" ");
	},
};
