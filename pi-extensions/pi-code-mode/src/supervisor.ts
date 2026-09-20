import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LIMITS } from "./limits.ts";

const systemctl = "/usr/bin/systemctl";
const systemdRun = "/usr/bin/systemd-run";

export function control(command: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 4000, maxBuffer: 64 * 1024, signal, env: {
			PATH: "/usr/bin", ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
			...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
		} }, (error, stdout, stderr) => {
			if (error) reject(new Error(`Code Mode supervision failed: ${error.message.slice(0, 512)} ${stderr.slice(0, 512)}`));
			else resolve(stdout.trim());
		});
	});
}

export class Supervisor {
	readonly unit = `pi-code-mode-${randomUUID()}.service`;
	readonly child: ChildProcessWithoutNullStreams;
	readonly exited: Promise<void>;
	private dead = false;
	private stopped?: Promise<void>;
	private watchdogs = new Set<string>();
	private disarming = new Map<string, Promise<void>>();
	private group?: string;
	private command = control;

	constructor(binary: string, directory: string, options: { args?: string[]; cwd?: string; path?: string } = {}) {
		this.child = spawn(systemdRun, [
			"--user", "--quiet", "--pipe", "--wait", "--service-type=exec", `--unit=${this.unit}`,
			`--property=MemoryMax=${LIMITS.memoryBytes}`, "--property=MemorySwapMax=0",
			"--property=TasksMax=64", "--property=CPUQuota=100%", "--property=RuntimeMaxSec=1h",
			"--property=TimeoutStopSec=2s", "--property=KillMode=control-group", "--property=OOMPolicy=kill",
			"--property=LimitCORE=0", "--property=UMask=0077", "--property=NoNewPrivileges=yes",
			...(options.cwd ? [`--working-directory=${options.cwd}`] : []),
			"/usr/bin/env", "-i", `HOME=${directory}`, `TMPDIR=${directory}`,
			...(options.path ? [`PATH=${options.path}`, "LC_ALL=C.UTF-8"] : []),
			binary, ...(options.args ?? []),
		], { stdio: "pipe", env: {
			PATH: "/usr/bin", ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
			...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
		} });
		this.exited = new Promise((resolve) => {
			this.child.once("close", () => { this.dead = true; resolve(); });
		});
	}

	async verify(signal: AbortSignal): Promise<Record<string, string>> {
		const properties = await this.command(systemctl, ["--user", "show", this.unit,
			"--property=ControlGroup,MainPID,RuntimeMaxUSec,LimitCORE,KillMode,OOMPolicy"], signal);
		const values = Object.fromEntries(properties.split("\n").map((line) => {
			const index = line.indexOf("=");
			return [line.slice(0, index), line.slice(index + 1)];
		}));
		const group = values.ControlGroup;
		if (!group?.startsWith("/") || group.split("/").includes("..") || !/^[1-9]\d*$/.test(values.MainPID ?? "")) throw new Error("Cannot verify Host cgroup identity");
		const kernel = Object.fromEntries(await Promise.all(
			["memory.max", "memory.swap.max", "pids.max", "cpu.max"].map(async (name) =>
				[name, (await readFile(`/sys/fs/cgroup${group}/${name}`, "utf8")).trim()]),
		));
		const [quota, period] = kernel["cpu.max"].split(/\s+/).map(Number);
		if (kernel["memory.max"] !== String(LIMITS.memoryBytes) || kernel["memory.swap.max"] !== "0"
			|| kernel["pids.max"] !== "64" || !Number.isFinite(quota) || quota <= 0 || quota !== period
			|| values.RuntimeMaxUSec !== "1h" || values.LimitCORE !== "0"
			|| values.KillMode !== "control-group" || values.OOMPolicy !== "kill") throw new Error("Kernel Host resource limits are not effective");
		if ((await readFile(`/proc/${values.MainPID}/cgroup`, "utf8")).trim() !== `0::${group}`) throw new Error("Host is outside its supervised cgroup");
		this.group = group;
		signal.throwIfAborted();
		return kernel;
	}

	/** A separate systemd timer kills this Host even if Pi stops processing JS.
	 * A new identity per exec avoids timer-rearming/completion races. */
	async arm(signal: AbortSignal, seconds: number = LIMITS.watchdogSeconds): Promise<() => Promise<void>> {
		if (!Number.isInteger(seconds) || seconds < 1 || seconds > LIMITS.watchdogSeconds) throw new Error("Invalid watchdog deadline");
		const name = `pi-code-mode-deadline-${randomUUID()}`;
		this.watchdogs.add(name);
		try {
			await this.command(systemdRun, ["--user", "--quiet", `--unit=${name}`,
				`--on-active=${seconds}s`, "--timer-property=AccuracySec=100ms",
				"--property=TimeoutStartSec=5s", systemctl, "--user", "kill",
				"--kill-whom=all", "--signal=SIGKILL", this.unit], signal);
			const state = await this.command(systemctl, ["--user", "show", `${name}.timer`, "--property=ActiveState", "--value"], signal);
			if (state !== "active") throw new Error("Execution watchdog was not armed");
		} catch (error) { await this.disarm(name).catch(() => {}); throw error; }
		return () => this.disarm(name);
	}

	private async stopUnits(units: string[]): Promise<void> {
		try { await this.command(systemctl, ["--user", "stop", ...units]); }
		catch (error) {
			// systemd may GC an inactive transient service while stopping its
			// timer. Verify the postcondition; never ignore a live/unknown unit.
			for (const unit of units) {
				const state = await this.command(systemctl, ["--user", "show", unit, "--property=ActiveState", "--value"]);
				if (!["inactive", "failed"].includes(state)) throw error;
			}
		}
	}

	private disarm(name: string): Promise<void> {
		if (!this.watchdogs.has(name)) return Promise.resolve();
		const prior = this.disarming.get(name);
		if (prior) return prior;
		const work = this.stopUnits([`${name}.timer`, `${name}.service`]).then(() => {
			this.watchdogs.delete(name);
		}).finally(() => { this.disarming.delete(name); });
		this.disarming.set(name, work);
		return work;
	}

	private async confirmStopped(): Promise<void> {
		const state = await this.command(systemctl, ["--user", "show", this.unit, "--property=ActiveState", "--value"]);
		if (!["inactive", "failed"].includes(state)) throw new Error("Host termination is not confirmed");
		if (this.group) {
			try {
				const events = await readFile(`/sys/fs/cgroup${this.group}/cgroup.events`, "utf8");
				if (!/^populated 0$/m.test(events)) throw new Error("Host cgroup is still populated");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}

	stop(): Promise<void> {
		return this.stopped ??= (async () => {
			let failure: unknown;
			try {
				try { await this.stopUnits([this.unit]); }
				catch {
					await this.command(systemctl, ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", this.unit]);
					await delay(100);
				}
				await this.confirmStopped();
				for (const name of this.watchdogs) await this.disarm(name);
				await this.command(systemctl, ["--user", "reset-failed", this.unit]).catch(() => {});
			} catch (error) {
				// Leave the OS execution timer armed if death is not confirmed.
				// Killing the proxy alone is NOT a claim that the Host stopped.
				failure = error;
			}
			this.child.kill("SIGKILL");
			this.child.stdin.destroy();
			this.child.stdout.destroy();
			this.child.stderr.destroy();
			if (!this.dead) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([this.exited, new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("Host proxy did not exit; OS watchdog retained")), 1000);
					})]);
				} catch (error) { failure ??= error; this.child.unref(); }
				finally { clearTimeout(timer); }
			}
			if (failure) throw failure;
		})();
	}
}
