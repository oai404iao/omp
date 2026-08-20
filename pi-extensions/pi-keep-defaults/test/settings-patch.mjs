import assert from "node:assert/strict";
import { installSettingsPatch, SETTINGS_SETTERS } from "../src/settings-patch.ts";

const PATCHED = Symbol.for("pi-keep-defaults.settings-manager-patched");

function createSettingsManager() {
	class FakeSettingsManager {
		values = [];

		setDefaultModelAndProvider(...args) {
			this.values.push(["setDefaultModelAndProvider", ...args]);
			return "model-provider";
		}

		setDefaultProvider(...args) {
			this.values.push(["setDefaultProvider", ...args]);
			return "provider";
		}

		setDefaultModel(...args) {
			this.values.push(["setDefaultModel", ...args]);
			return "model";
		}

		setDefaultThinkingLevel(...args) {
			this.values.push(["setDefaultThinkingLevel", ...args]);
			return "thinking";
		}
	}
	return FakeSettingsManager;
}

function snapshot(prototype) {
	return Object.fromEntries(SETTINGS_SETTERS.map((name) => [name, Object.getOwnPropertyDescriptor(prototype, name)]));
}

function assertSnapshot(prototype, before) {
	for (const name of SETTINGS_SETTERS) {
		assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, name), before[name], `${name} must not be modified`);
	}
	assert.equal(Object.prototype.hasOwnProperty.call(prototype, PATCHED), false, "failed preflight must not add a marker");
}

for (const incompatible of ["missing", "accessor", "unreplaceable"]) {
	const Manager = createSettingsManager();
	const prototype = Manager.prototype;
	if (incompatible === "missing") {
		delete prototype.setDefaultModel;
	} else if (incompatible === "accessor") {
		Object.defineProperty(prototype, "setDefaultModel", {
			get: () => () => {},
			configurable: true,
		});
	} else {
		Object.defineProperty(prototype, "setDefaultModel", {
			...Object.getOwnPropertyDescriptor(prototype, "setDefaultModel"),
			writable: false,
			configurable: false,
		});
	}
	const before = snapshot(prototype);
	const result = installSettingsPatch(Manager, () => true);
	assert.equal(result.installed, false, `${incompatible} setter shape must be rejected`);
	assertSnapshot(prototype, before);
}
console.log("PASS: incompatible setter descriptors cause no partial patch");

{
	const Manager = createSettingsManager();
	Object.defineProperty(Manager.prototype, "setDefaultProvider", {
		...Object.getOwnPropertyDescriptor(Manager.prototype, "setDefaultProvider"),
		writable: false,
	});
	Object.defineProperty(Manager.prototype, "setDefaultModel", {
		...Object.getOwnPropertyDescriptor(Manager.prototype, "setDefaultModel"),
		enumerable: true,
	});
	let enabled = true;
	const result = installSettingsPatch(Manager, () => enabled);
	assert.deepEqual(result, { installed: true, mode: "installed-v2" });
	const wrappers = snapshot(Manager.prototype);
	const markerDescriptor = Object.getOwnPropertyDescriptor(Manager.prototype, PATCHED);
	assert.deepEqual(
		{
			writable: markerDescriptor.writable,
			enumerable: markerDescriptor.enumerable,
			configurable: markerDescriptor.configurable,
		},
		{ writable: false, enumerable: false, configurable: true },
		"the v2 marker descriptor must have the exact required flags",
	);
	for (const name of SETTINGS_SETTERS) {
		assert.deepEqual(
			markerDescriptor.value.descriptors[name],
			{
				writable: wrappers[name].writable,
				enumerable: wrappers[name].enumerable,
				configurable: wrappers[name].configurable,
			},
			`${name} descriptor flags must be saved in the v2 marker`,
		);
	}
	const instance = new Manager();

	assert.equal(instance.setDefaultProvider("anthropic"), undefined);
	assert.equal(instance.setDefaultModel("claude"), undefined);
	assert.equal(instance.setDefaultModelAndProvider("openai", "gpt"), undefined);
	assert.equal(instance.setDefaultThinkingLevel("high"), undefined);
	assert.deepEqual(instance.values, [], "protection on must block every setter");

	enabled = false;
	assert.equal(instance.setDefaultProvider("anthropic"), "provider");
	assert.equal(instance.setDefaultModel("claude"), "model");
	assert.equal(instance.setDefaultModelAndProvider("openai", "gpt"), "model-provider");
	assert.equal(instance.setDefaultThinkingLevel("high"), "thinking");
	assert.equal(instance.values.length, 4, "protection off must delegate every setter");

	assert.deepEqual(installSettingsPatch(Manager, () => true), { installed: true, mode: "existing-v2" });
	for (const name of SETTINGS_SETTERS) {
		assert.equal(Object.getOwnPropertyDescriptor(Manager.prototype, name).value, wrappers[name].value);
	}
}
console.log("PASS: v2 patch blocks/delegates all setters and reload is idempotent");

{
	const Manager = createSettingsManager();
	assert.equal(installSettingsPatch(Manager, () => true).installed, true);
	const wrapper = Manager.prototype.setDefaultModel;
	Object.defineProperty(Manager.prototype, "setDefaultModel", {
		...Object.getOwnPropertyDescriptor(Manager.prototype, "setDefaultModel"),
		enumerable: true,
	});
	const result = installSettingsPatch(Manager, () => true);
	assert.equal(result.installed, false, "existing v2 setter flags must be verified, not only wrapper identity");
	assert.equal(Manager.prototype.setDefaultModel, wrapper);
	assert.match(result.reason, /descriptor flags/);
}
console.log("PASS: existing v2 wrappers require matching setter descriptor flags");

{
	const Manager = createSettingsManager();
	assert.equal(installSettingsPatch(Manager, () => true).installed, true);
	const descriptor = Object.getOwnPropertyDescriptor(Manager.prototype, PATCHED);
	Object.defineProperty(Manager.prototype, PATCHED, { ...descriptor, enumerable: true });
	const result = installSettingsPatch(Manager, () => true);
	assert.equal(result.installed, false);
	assert.match(result.reason, /marker descriptor flags/);
}
console.log("PASS: existing v2 marker requires exact descriptor flags");

{
	const Manager = createSettingsManager();
	const prototype = Manager.prototype;
	const originals = snapshot(prototype);
	let failOnce = true;
	const proxy = new Proxy(prototype, {
		defineProperty(target, property, descriptor) {
			if (property === "setDefaultProvider" && failOnce) {
				failOnce = false;
				Reflect.defineProperty(target, property, descriptor);
				throw new Error("injected installation failure");
			}
			return Reflect.defineProperty(target, property, descriptor);
		},
	});
	const result = installSettingsPatch({ prototype: proxy }, () => true);
	assert.equal(result.installed, false);
	assertSnapshot(prototype, originals);
}
console.log("PASS: installation failure rolls back earlier setters");

{
	const Manager = createSettingsManager();
	const prototype = Manager.prototype;
	const originals = snapshot(prototype);
	const proxy = new Proxy(prototype, {
		defineProperty(target, property, descriptor) {
			if (property === PATCHED) return true;
			return Reflect.defineProperty(target, property, descriptor);
		},
	});
	const result = installSettingsPatch({ prototype: proxy }, () => true);
	assert.equal(result.installed, false, "a marker that was not installed must not report success");
	assertSnapshot(prototype, originals);
}
console.log("PASS: missing post-install marker verification rolls back all wrappers");

{
	const Manager = createSettingsManager();
	const prototype = Manager.prototype;
	const originals = snapshot(prototype);
	const proxy = new Proxy(prototype, {
		defineProperty(target, property, descriptor) {
			if (
				SETTINGS_SETTERS.includes(property) &&
				typeof descriptor.value === "function" &&
				descriptor.value.name === "keepDefaultsPatchedSetter"
			) {
				return Reflect.defineProperty(target, property, { ...descriptor, enumerable: !descriptor.enumerable });
			}
			return Reflect.defineProperty(target, property, descriptor);
		},
	});
	const result = installSettingsPatch({ prototype: proxy }, () => true);
	assert.equal(result.installed, false, "a trap that preserves wrapper identity but changes flags must be detected");
	assert.match(result.reason, /descriptor flags/);
	assertSnapshot(prototype, originals);
}
console.log("PASS: post-install setter flag tampering is detected and rolled back");

{
	const Manager = createSettingsManager();
	const prototype = Manager.prototype;
	const originals = snapshot(prototype);
	let markerInstalled = false;
	let throwOnce = true;
	const proxy = new Proxy(prototype, {
		defineProperty(target, property, descriptor) {
			const result = Reflect.defineProperty(target, property, descriptor);
			if (property === PATCHED) markerInstalled = true;
			return result;
		},
		getOwnPropertyDescriptor(target, property) {
			if (markerInstalled && property === "setDefaultModelAndProvider" && throwOnce) {
				throwOnce = false;
				throw new Error("injected post-install reflection failure");
			}
			return Reflect.getOwnPropertyDescriptor(target, property);
		},
	});
	const result = installSettingsPatch({ prototype: proxy }, () => true);
	assert.equal(result.installed, false, "post-install verification exceptions must become compatibility failures");
	assert.match(result.reason, /verification failed/);
	assertSnapshot(prototype, originals);
}
console.log("PASS: post-install reflection exceptions roll back and return installed false");

{
	const Manager = createSettingsManager();
	const identities = {};
	const legacyState = { enabled: true };
	function getState() {
		return legacyState;
	}
	for (const name of SETTINGS_SETTERS) {
		const original = Manager.prototype[name];
		const wrapper = function patchedDefaultSetter(...args) {
			const state = getState();
			if (state.enabled) return undefined;
			return Reflect.apply(original, this, args);
		};
		Object.defineProperty(Manager.prototype, name, {
			...Object.getOwnPropertyDescriptor(Manager.prototype, name),
			value: wrapper,
		});
		identities[name] = wrapper;
	}
	Manager.prototype[PATCHED] = 1;

	assert.deepEqual(installSettingsPatch(Manager, () => true), { installed: true, mode: "legacy-v1" });
	assert.equal(Manager.prototype[PATCHED], 1, "validated v1 marker must be retained");
	for (const name of SETTINGS_SETTERS) {
		assert.equal(Manager.prototype[name], identities[name], "v1 wrapper must not be wrapped again");
	}
	const instance = new Manager();
	instance.setDefaultModel("blocked");
	assert.deepEqual(instance.values, []);
	legacyState.enabled = false;
	instance.setDefaultModel("delegated");
	assert.deepEqual(instance.values, [["setDefaultModel", "delegated"]]);
}
console.log("PASS: validated numeric v1 patch is retained without double wrapping");

{
	const Manager = createSettingsManager();
	for (const name of SETTINGS_SETTERS) {
		const original = Manager.prototype[name];
		Manager.prototype[name] = function patchedDefaultSetter(...args) {
			return Reflect.apply(original, this, args);
		};
	}
	Manager.prototype[PATCHED] = 1;
	const before = snapshot(Manager.prototype);
	const result = installSettingsPatch(Manager, () => true);
	assert.equal(result.installed, false, "a same-name pass-through wrapper is not a validated v1 patch");
	for (const name of SETTINGS_SETTERS) {
		assert.equal(Manager.prototype[name], before[name].value);
	}
}
console.log("PASS: unverified numeric v1 marker safely falls back without wrapping");

{
	const result = installSettingsPatch(
		{
			get prototype() {
				throw new Error("injected prototype getter failure");
			},
		},
		() => true,
	);
	assert.equal(result.installed, false);
	assert.match(result.reason, /prototype inspection failed/);
}

{
	const Manager = createSettingsManager();
	const target = Manager.prototype;
	const before = snapshot(target);
	const proxy = new Proxy(target, {
		getOwnPropertyDescriptor(_target, property) {
			if (property === "setDefaultModel") throw new Error("injected descriptor trap failure");
			return Reflect.getOwnPropertyDescriptor(target, property);
		},
	});
	const result = installSettingsPatch({ prototype: proxy }, () => true);
	assert.equal(result.installed, false);
	assert.match(result.reason, /setter inspection failed/);
	assertSnapshot(target, before);
}

{
	const Manager = createSettingsManager();
	let getterCalls = 0;
	Object.defineProperty(Manager.prototype, PATCHED, {
		get() {
			getterCalls += 1;
			throw new Error("marker getter must not run");
		},
		configurable: true,
	});
	const result = installSettingsPatch(Manager, () => true);
	assert.equal(result.installed, false);
	assert.match(result.reason, /not a data property/);
	assert.equal(getterCalls, 0, "marker accessors must be rejected without invoking their getter");
}

{
	const Manager = createSettingsManager();
	const throwingMarker = new Proxy(
		{},
		{
			get() {
				throw new Error("injected marker proxy failure");
			},
		},
	);
	Object.defineProperty(Manager.prototype, PATCHED, {
		value: throwingMarker,
		writable: false,
		enumerable: false,
		configurable: true,
	});
	const result = installSettingsPatch(Manager, () => true);
	assert.equal(result.installed, false);
	assert.match(result.reason, /marker validation failed/);
}

{
	const Manager = createSettingsManager();
	for (const name of SETTINGS_SETTERS) {
		const original = Manager.prototype[name];
		Manager.prototype[name] = function patchedDefaultSetter(...args) {
			const state = { enabled: true };
			if (state.enabled) return undefined;
			return Reflect.apply(original, this, args);
		};
	}
	Manager.prototype[PATCHED] = 1;
	const originalToString = Function.prototype.toString;
	Function.prototype.toString = () => {
		throw new Error("injected Function.toString failure");
	};
	try {
		const result = installSettingsPatch(Manager, () => true);
		assert.equal(result.installed, false);
		assert.match(result.reason, /marker validation failed/);
	} finally {
		Function.prototype.toString = originalToString;
	}
}
console.log("PASS: throwing compatibility reflection degrades to installed false");

console.log("\nAll SettingsManager compatibility tests passed.");
