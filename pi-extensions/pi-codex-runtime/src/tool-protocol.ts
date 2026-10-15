export interface ToolProtocol {
	readonly customTool: Readonly<Record<string, unknown>>;
	readonly inputProperty: string;
	readonly hiddenTools?: readonly string[];
}

export type ToolProtocolSnapshot = (
	tools?: readonly { name: string; description: string; parameters: unknown }[],
) => ReadonlyMap<string, ToolProtocol>;
