// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Task Tool — Generic subagent for delegating work with isolated context
 *
 * Like Claude Code's Task tool. Spawns a separate `pi` process for each
 * invocation, giving it a fresh context window with full tool access.
 * The parent conversation's context is preserved while the subtask runs
 * in isolation.
 *
 * No agent definitions or configuration required — just describe the task.
 *
 * Note: This extension runs inside pi, so `pi` is always available on PATH
 * (the parent process IS pi). No availability check is needed.
 *
 * Modes:
 *   - Single: { task: "..." }
 *   - Parallel: { tasks: [{ task: "...", model?: "..." }, ...] }
 *
 * Based on pi's subagent example extension, simplified for generic use.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEMS = 10;
const EXTENSION_DIR = path.dirname(new URL(import.meta.url).pathname);
const MAX_TASK_DEPTH = 3;
// PI_CMD allows wrappers (e.g., `devx pi`) to tell subtasks how to invoke pi.
// Falls back to `pi` if unset. The value is propagated to child processes automatically.
const PI_CMD = process.env.PI_CMD || "pi";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(
	name: string,
	args: Record<string, unknown>,
	fg: (color: any, text: string) => string,
): string {
	switch (name) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			const preview = cmd.length > 80 ? `${cmd.slice(0, 80)}...` : cmd;
			return fg("muted", "$ ") + fg("toolOutput", preview);
		}
		case "read": {
			const raw = (args.file_path || args.path || "...") as string;
			let text = fg("accent", shortenPath(raw));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const raw = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(raw));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const raw = (args.file_path || args.path || "...") as string;
			return fg("muted", "edit ") + fg("accent", shortenPath(raw));
		}
		case "ls": {
			const raw = (args.path || ".") as string;
			return fg("muted", "ls ") + fg("accent", shortenPath(raw));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const raw = (args.path || ".") as string;
			return fg("muted", "find ") + fg("accent", pattern) + fg("dim", ` in ${shortenPath(raw)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const raw = (args.path || ".") as string;
			return fg("muted", "grep ") + fg("accent", `/${pattern}/`) + fg("dim", ` in ${shortenPath(raw)}`);
		}
		default: {
			const s = JSON.stringify(args);
			const preview = s.length > 60 ? `${s.slice(0, 60)}...` : s;
			return fg("accent", name) + fg("dim", ` ${preview}`);
		}
	}
}

// ── Types ────────────────────────────────────────────────────────────────────

interface TaskResult {
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface TaskDetails {
	mode: "single" | "parallel";
	results: TaskResult[];
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

// ── Process runner ───────────────────────────────────────────────────────────

function writeTempPrompt(label: string, content: string): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-"));
	const safe = label.replace(/[^\w.-]+/g, "_").slice(0, 40);
	const file = path.join(dir, `prompt-${safe}.md`);
	fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, file };
}

type OnUpdate = (partial: AgentToolResult<TaskDetails>) => void;

async function runTask(
	cwd: string,
	task: string,
	systemPrompt: string | undefined,
	model: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdate | undefined,
	makeDetails: (results: TaskResult[]) => TaskDetails,
): Promise<TaskResult> {
	// Build args: full tool access, JSON output, no session persistence
	const args: string[] = [
		"--mode", "json", "-p", "--no-session",
		"--no-extensions", "--no-skills", "--no-prompt-templates",
		"-e", EXTENSION_DIR,
	];
	if (model) args.push("--model", model);
	// Propagate the parent's active tool list so subtasks inherit tool restrictions
	// (e.g., if the parent is read-only, subtasks won't get edit/write).
	// Filter out "task" since it's loaded via -e extension, not --tools.
	if (piApi) {
		const parentTools = piApi.getActiveTools().filter((t: string) => t !== "task");
		if (parentTools.length > 0) {
			args.push("--tools", parentTools.join(","));
		}
	}

	// Validate working directory before spawning
	if (!fs.existsSync(cwd)) {
		return {
			task,
			exitCode: 1,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			model,
			errorMessage: `Working directory does not exist: ${cwd}`,
		};
	}

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;

	const result: TaskResult = {
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model,
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
			details: makeDetails([result]),
		});
	};

	try {
		// Optionally append a system prompt (for future use by skills/agents)
		if (systemPrompt?.trim()) {
			const tmp = writeTempPrompt("task", systemPrompt);
			tmpDir = tmp.dir;
			tmpFile = tmp.file;
			args.push("--append-system-prompt", tmpFile);
		}

		// Task text goes as the positional prompt argument
		args.push(task);

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const currentDepth = parseInt(process.env.PI_TASK_DEPTH || "0", 10);
			const useShell = PI_CMD.includes(" ");
			const proc = spawn(useShell ? `${PI_CMD} ${args.join(" ")}` : PI_CMD, useShell ? [] : args, {
				cwd,
				shell: useShell,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_TASK_DEPTH: String(currentDepth + 1), PI_CMD },
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code: number | null) => {
				if (buffer.trim()) processLine(buffer);
				if (signal && killFn) signal.removeEventListener("abort", killFn);
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				if (signal && killFn) signal.removeEventListener("abort", killFn);
				result.errorMessage = `Failed to spawn pi: ${err.message}`;
				resolve(1);
			});

			let killFn: (() => void) | undefined;
			if (signal) {
				killFn = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killFn();
				else signal.addEventListener("abort", killFn, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.exitCode = exitCode || 1;
			result.stopReason = "aborted";
			result.errorMessage = "Task was aborted";
			return result;
		}
		return result;
	} finally {
		if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: R[] = new Array(items.length);
	let next = 0;
	let firstError: unknown;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = await fn(items[i], i);
			} catch (err) {
				if (!firstError) firstError = err;
			}
		}
	});
	await Promise.allSettled(workers);
	if (firstError) throw firstError;
	return results;
}

// Module-level reference to the pi API so runTask() can access it
let piApi: ExtensionAPI | undefined;

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	piApi = pi;
	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Delegate a task to a subagent with an isolated context window and full tool access.",
			"Use this to preserve your current context while performing work that requires",
			"exploring the codebase, running commands, or making changes.",
			"The subtask gets its own fresh context with the same tools available to the parent session.",
			"For parallel work, pass an array of task objects, each with an optional model override.",
			"Use when the user says things like: 'use a task to...', 'use a subtask to...',",
			"'use a subagent to...', 'delegate to...', 'spawn a task for...',",
			"'in a separate context...', 'without losing context...',",
			"'run this in isolation', or 'in parallel, do...'.",
		].join(" "),
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
			tasks: Type.Optional(Type.Array(
				Type.Object({
					task: Type.String({ description: "The task to perform" }),
					model: Type.Optional(Type.String({ description: "Override model for this specific task" })),
				}),
				{ description: "Multiple tasks to run in parallel, each with an optional model override" },
			)),
			model: Type.Optional(Type.String({ description: "Override model for the subtask (e.g. 'claude-haiku-4-5')" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subtask" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const currentDepth = parseInt(process.env.PI_TASK_DEPTH || "0", 10);
			if (currentDepth >= MAX_TASK_DEPTH) {
				return {
					content: [{ type: "text", text: `Maximum task nesting depth (${MAX_TASK_DEPTH}) reached. Cannot spawn further subtasks.` }],
					details: { mode: "single" as const, results: [] },
				};
			}

			const hasSingle = Boolean(params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;

			if (!hasSingle && !hasParallel) {
				return {
					content: [{ type: "text", text: "Provide either `task` (string) or `tasks` (array of strings)." }],
					details: { mode: "single" as const, results: [] },
				};
			}

			if (hasSingle && hasParallel) {
				return {
					content: [{ type: "text", text: "Provide either `task` or `tasks`, not both." }],
					details: { mode: "single" as const, results: [] },
				};
			}

			const makeDetails = (mode: "single" | "parallel") => (results: TaskResult[]): TaskDetails => ({
				mode,
				results,
			});

			const workDir = params.cwd ?? ctx.cwd;

			// ── Single task ──────────────────────────────────────────────
			if (params.task) {
				const result = await runTask(
					workDir,
					params.task,
					undefined, // no extra system prompt
					params.model,
					signal,
					onUpdate,
					makeDetails("single"),
				);

				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const msg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Task ${result.stopReason || "failed"}: ${msg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			// ── Parallel tasks ───────────────────────────────────────────
			const tasks = params.tasks!;
			if (tasks.length > MAX_PARALLEL) {
				return {
					content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL}.` }],
					details: makeDetails("parallel")([]),
				};
			}

			const allResults: TaskResult[] = tasks.map((t) => ({
				task: t.task,
				exitCode: -1, // -1 = running
				messages: [],
				stderr: "",
				usage: emptyUsage(),
				model: t.model ?? params.model,
			}));

			const emitParallelUpdate = () => {
				if (!onUpdate) return;
				const running = allResults.filter((r) => r.exitCode === -1).length;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails("parallel")([...allResults]),
				});
			};

			const results = await mapConcurrent(tasks, MAX_CONCURRENCY, async (t, index) => {
				const result = await runTask(
					workDir,
					t.task,
					undefined,
					t.model ?? params.model,
					signal,
					(partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
					},
					makeDetails("parallel"),
				);
				allResults[index] = result;
				emitParallelUpdate();
				return result;
			});

			const ok = results.filter((r) => r.exitCode === 0).length;
			const summaries = results.map((r) => {
				const out = getFinalOutput(r.messages);
				const preview = out.slice(0, 200) + (out.length > 200 ? "..." : "");
				return `[task] ${r.exitCode === 0 ? "✓" : "✗"}: ${preview || "(no output)"}`;
			});

			return {
				content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
				details: makeDetails("parallel")(results),
			};
		},

		// ── Rendering ────────────────────────────────────────────────────

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("task "))
					+ theme.fg("accent", `parallel (${args.tasks.length})`);
				if (args.model) text += theme.fg("muted", ` [${args.model}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const taskText = typeof t === "string" ? t : t.task;
					const taskModel = typeof t === "string" ? undefined : t.model;
					const preview = taskText.length > 60 ? `${taskText.slice(0, 60)}...` : taskText;
					let line = `\n  ${theme.fg("dim", preview)}`;
					if (taskModel) line += theme.fg("muted", ` [${taskModel}]`);
					text += line;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			const preview = args.task
				? (args.task.length > 80 ? `${args.task.slice(0, 80)}...` : args.task)
				: "...";
			let text = theme.fg("toolTitle", theme.bold("task"));
			if (args.model) text += theme.fg("muted", ` [${args.model}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const renderItems = (items: DisplayItem[], limit?: number) => {
				const show = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of show) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			// ── Single result ────────────────────────────────────────────
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isErr = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isErr ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = getDisplayItems(r.messages);
				const usage = formatUsage(r.usage, r.model);

				if (expanded) {
					const c = new Container();
					let hdr = `${icon} ${theme.fg("toolTitle", theme.bold("task"))}`;
					if (isErr && r.stopReason) hdr += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					c.addChild(new Text(hdr, 0, 0));
					if (isErr && r.errorMessage) c.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (items.length === 0) {
						c.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of items) {
							if (item.type === "toolCall") {
								c.addChild(new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
							} else {
								c.addChild(new Text(theme.fg("toolOutput", item.text), 0, 0));
							}
						}
					}
					if (usage) { c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("dim", usage), 0, 0)); }
					return c;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("task"))}`;
				if (isErr && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isErr && r.errorMessage) {
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				} else if (items.length === 0) {
					text += `\n${theme.fg("muted", "(no output)")}`;
				} else {
					text += `\n${renderItems(items, COLLAPSED_ITEMS)}`;
					if (items.length > COLLAPSED_ITEMS) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				if (usage) text += `\n${theme.fg("dim", usage)}`;
				return new Text(text, 0, 0);
			}

			// ── Parallel results ─────────────────────────────────────────
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const ok = details.results.filter((r) => r.exitCode === 0).length;
			const fail = details.results.filter((r) => r.exitCode !== 0 && r.exitCode !== -1).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: fail > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${ok + fail}/${details.results.length} done, ${running} running`
				: `${ok}/${details.results.length} tasks`;

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("task "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon = r.exitCode === -1
					? theme.fg("warning", "⏳")
					: r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const items = getDisplayItems(r.messages);
				const taskPreview = r.task.length > 50 ? `${r.task.slice(0, 50)}...` : r.task;
				const modelTag = r.model ? theme.fg("muted", ` [${r.model}]`) : "";
				text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("dim", taskPreview)}${modelTag} ${rIcon}`;
				if (items.length === 0) {
					text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
				} else {
					text += `\n${renderItems(items, expanded ? undefined : 5)}`;
				}
			}

			if (!isRunning) {
				const total = emptyUsage();
				for (const r of details.results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				const u = formatUsage(total);
				if (u) text += `\n\n${theme.fg("dim", `Total: ${u}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
