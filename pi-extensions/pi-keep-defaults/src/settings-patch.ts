const PATCHED = Symbol.for("pi-keep-defaults.settings-manager-patched");

export const SETTINGS_SETTERS = [
	"setDefaultModelAndProvider",
	"setDefaultProvider",
	"setDefaultModel",
	"setDefaultThinkingLevel",
] as const;

type SetterName = (typeof SETTINGS_SETTERS)[number];
type Setter = (this: unknown, ...args: unknown[]) => unknown;

interface SettingsPatchMarkerV2 {
	kind: "pi-keep-defaults/settings-patch";
	version: 2;
	wrappers: Readonly<Record<SetterName, Setter>>;
	descriptors: Readonly<Record<SetterName, Readonly<SetterDescriptorFlags>>>;
}

export interface SettingsPatchResult {
	installed: boolean;
	mode?: "installed-v2" | "existing-v2" | "legacy-v1";
	reason?: string;
}

interface SetterDescriptor extends PropertyDescriptor {
	value: Setter;
}

interface SetterDescriptorFlags {
	writable: boolean;
	enumerable: boolean;
	configurable: boolean;
}

function caughtMessage(error: unknown): string {
	try {
		if (error instanceof Error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "unknown reflection error";
	}
}

function inspectSetters(prototype: object): { descriptors: Record<SetterName, SetterDescriptor> } | { reason: string } {
	const descriptors = {} as Record<SetterName, SetterDescriptor>;

	for (const name of SETTINGS_SETTERS) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
			return { reason: `${name} is not an own data-function property` };
		}
		if (descriptor.writable !== true && descriptor.configurable !== true) {
			return { reason: `${name} is not replaceable` };
		}
		descriptors[name] = descriptor as SetterDescriptor;
	}

	return { descriptors };
}

function hasV2Identity(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SettingsPatchMarkerV2>;
	return candidate.kind === "pi-keep-defaults/settings-patch" && candidate.version === 2;
}

function descriptorFlags(descriptor: SetterDescriptor): SetterDescriptorFlags {
	return {
		writable: descriptor.writable === true,
		enumerable: descriptor.enumerable === true,
		configurable: descriptor.configurable === true,
	};
}

function hasExactMarkerDescriptor(descriptor: PropertyDescriptor): boolean {
	return (
		"value" in descriptor &&
		descriptor.writable === false &&
		descriptor.enumerable === false &&
		descriptor.configurable === true
	);
}

function validateV2Marker(
	marker: SettingsPatchMarkerV2,
	markerDescriptor: PropertyDescriptor,
	descriptors: Record<SetterName, SetterDescriptor>,
): SettingsPatchResult {
	if (!hasExactMarkerDescriptor(markerDescriptor)) {
		return { installed: false, reason: "v2 patch marker descriptor flags are invalid" };
	}
	if (!marker.wrappers || typeof marker.wrappers !== "object") {
		return { installed: false, reason: "v2 patch marker has no wrapper identity table" };
	}
	if (!marker.descriptors || typeof marker.descriptors !== "object") {
		return { installed: false, reason: "v2 patch marker has no setter descriptor table" };
	}

	for (const name of SETTINGS_SETTERS) {
		if (typeof marker.wrappers[name] !== "function" || descriptors[name].value !== marker.wrappers[name]) {
			return { installed: false, reason: `v2 marker does not match the installed ${name} wrapper` };
		}
		const expected = marker.descriptors[name];
		if (
			!expected ||
			typeof expected !== "object" ||
			typeof expected.writable !== "boolean" ||
			typeof expected.enumerable !== "boolean" ||
			typeof expected.configurable !== "boolean" ||
			descriptors[name].writable !== expected.writable ||
			descriptors[name].enumerable !== expected.enumerable ||
			descriptors[name].configurable !== expected.configurable
		) {
			return { installed: false, reason: `v2 marker does not match the installed ${name} descriptor flags` };
		}
	}
	return { installed: true, mode: "existing-v2" };
}

function validateLegacyV1(descriptors: Record<SetterName, SetterDescriptor>): SettingsPatchResult {
	for (const name of SETTINGS_SETTERS) {
		// v1 did not mark individual wrappers. Its named wrapper plus the numeric
		// prototype marker and implementation fingerprint are the only identities
		// available during an in-process upgrade. Be conservative: an uncertain
		// match falls back to the file guard rather than layering another wrapper.
		const wrapper = descriptors[name].value;
		const source = Function.prototype.toString.call(wrapper);
		const matchesV1 =
			wrapper.name === "patchedDefaultSetter" &&
			/\bgetState\s*\(\s*\)/.test(source) &&
			/\.enabled\b/.test(source) &&
			/return\s+undefined\b/.test(source) &&
			/Reflect\.apply\s*\(\s*original\b/.test(source);
		if (!matchesV1) {
			return { installed: false, reason: `numeric v1 marker does not match the installed ${name} wrapper` };
		}
	}
	return { installed: true, mode: "legacy-v1" };
}

/**
 * Install the process-global SettingsManager patch transactionally.
 *
 * Every setter is inspected before the first mutation. Existing v2 wrappers
 * are accepted only when the structured marker points at the functions that
 * are still installed. A validated v1 patch is retained as-is because its
 * original functions are no longer recoverable without double wrapping.
 */
export function installSettingsPatch(settingsManager: unknown, protectionEnabled: () => boolean): SettingsPatchResult {
	let prototype: unknown;
	try {
		prototype = (settingsManager as { prototype?: unknown } | null)?.prototype;
	} catch (error) {
		return {
			installed: false,
			reason: `SettingsManager.prototype inspection failed: ${caughtMessage(error)}`,
		};
	}
	if ((typeof prototype !== "object" && typeof prototype !== "function") || prototype === null) {
		return { installed: false, reason: "SettingsManager.prototype is unavailable" };
	}

	let inspection: ReturnType<typeof inspectSetters>;
	try {
		inspection = inspectSetters(prototype);
	} catch (error) {
		return {
			installed: false,
			reason: `SettingsManager setter inspection failed: ${caughtMessage(error)}`,
		};
	}
	if ("reason" in inspection) return { installed: false, reason: inspection.reason };
	const { descriptors } = inspection;

	let markerDescriptor: PropertyDescriptor | undefined;
	try {
		markerDescriptor = Object.getOwnPropertyDescriptor(prototype, PATCHED);
	} catch (error) {
		return {
			installed: false,
			reason: `settings patch marker inspection failed: ${caughtMessage(error)}`,
		};
	}
	if (markerDescriptor) {
		if (!("value" in markerDescriptor)) {
			return { installed: false, reason: "settings patch marker is not a data property" };
		}
		try {
			if (hasV2Identity(markerDescriptor.value)) {
				return validateV2Marker(markerDescriptor.value as SettingsPatchMarkerV2, markerDescriptor, descriptors);
			}
			if (markerDescriptor.value === 1) {
				return validateLegacyV1(descriptors);
			}
		} catch (error) {
			return {
				installed: false,
				reason: `settings patch marker validation failed: ${caughtMessage(error)}`,
			};
		}
		return { installed: false, reason: "settings patch marker has an unknown or invalid shape" };
	}

	let extensible: boolean;
	try {
		extensible = Object.isExtensible(prototype);
	} catch (error) {
		return {
			installed: false,
			reason: `SettingsManager.prototype extensibility inspection failed: ${caughtMessage(error)}`,
		};
	}
	if (!extensible) {
		return { installed: false, reason: "SettingsManager.prototype cannot accept the patch marker" };
	}

	const wrappers = {} as Record<SetterName, Setter>;
	const savedDescriptorFlags = {} as Record<SetterName, Readonly<SetterDescriptorFlags>>;
	for (const name of SETTINGS_SETTERS) {
		const original = descriptors[name].value;
		wrappers[name] = function keepDefaultsPatchedSetter(this: unknown, ...args: unknown[]): unknown {
			if (protectionEnabled()) return undefined;
			return Reflect.apply(original, this, args);
		};
		savedDescriptorFlags[name] = Object.freeze(descriptorFlags(descriptors[name]));
	}

	const marker: SettingsPatchMarkerV2 = Object.freeze({
		kind: "pi-keep-defaults/settings-patch",
		version: 2,
		wrappers: Object.freeze({ ...wrappers }),
		descriptors: Object.freeze({ ...savedDescriptorFlags }),
	});
	const rollback = (): unknown => {
		try {
			Reflect.deleteProperty(prototype, PATCHED);
		} catch {
			// A Proxy trap may mutate and then throw. Verify the final state below.
		}
		// Restore every preflight snapshot, not merely setters whose define call
		// returned. A Proxy trap can mutate its target and then throw.
		for (const name of [...SETTINGS_SETTERS].reverse()) {
			try {
				Object.defineProperty(prototype, name, descriptors[name]);
			} catch {
				// The target may still have been restored. Verify it below.
			}
		}
		try {
			if (Object.getOwnPropertyDescriptor(prototype, PATCHED) !== undefined) {
				return new Error("v2 patch marker remained after rollback");
			}
			for (const name of SETTINGS_SETTERS) {
				const restored = Object.getOwnPropertyDescriptor(prototype, name);
				const original = descriptors[name];
				if (
					!restored ||
					restored.value !== original.value ||
					restored.writable !== original.writable ||
					restored.enumerable !== original.enumerable ||
					restored.configurable !== original.configurable
				) {
					return new Error(`${name} remained modified after rollback`);
				}
			}
		} catch (caught) {
			return new Error("could not verify SettingsManager rollback", { cause: caught });
		}
		return undefined;
	};

	let failureReason: string | undefined;
	try {
		for (const name of SETTINGS_SETTERS) {
			Object.defineProperty(prototype, name, { ...descriptors[name], value: wrappers[name] });
		}
		Object.defineProperty(prototype, PATCHED, {
			value: marker,
			writable: false,
			enumerable: false,
			configurable: true,
		});

		const installedMarker = Object.getOwnPropertyDescriptor(prototype, PATCHED);
		const verificationInspection = inspectSetters(prototype);
		const verification =
			installedMarker &&
			"value" in installedMarker &&
			installedMarker.value === marker &&
			"descriptors" in verificationInspection
				? validateV2Marker(marker, installedMarker, verificationInspection.descriptors)
				: {
						installed: false as const,
						reason:
							"reason" in verificationInspection
								? verificationInspection.reason
								: "v2 patch marker was not installed as the expected own data property",
					};
		if (!verification.installed) {
			failureReason = `installed SettingsManager wrappers could not be verified: ${verification.reason}`;
		}
	} catch (error) {
		failureReason = `SettingsManager patch installation or verification failed: ${caughtMessage(error)}`;
	}

	if (failureReason) {
		const rollbackError = rollback();
		if (rollbackError) {
			throw new Error("pi-keep-defaults: SettingsManager patch failed and rollback was incomplete", {
				cause: rollbackError,
			});
		}
		return {
			installed: false,
			reason: failureReason,
		};
	}
	return { installed: true, mode: "installed-v2" };
}
