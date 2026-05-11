/**
 * Tim Extension - Orchestrate parallel subagents
 *
 * Agents: planner, tukang, riset
 *
 * Workflow modes:
 * - "build": planner explores + splits → tukang×N → review
 * - "build-parallel": planner explores + splits → tukang×N
 * - "explore": planner explores only (no implementation)
 * - "research": riset only
 * - "implement": tukang only (provide context manually)
 * - "chain": custom sequential chain with {previous} placeholder
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Markdown, SelectList, type SelectItem, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; text?: string }>;
  usage: { input: number; output: number; cost: number; turns: number };
  error?: string;
  running?: boolean;
}

interface TimDetails {
  mode: string;
  results: AgentResult[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPiCmd(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  const isBunVirtual = script?.startsWith("/$bunfs/root/");
  if (script && !isBunVirtual && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const base = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(base)) return { command: "pi", args };
  return { command: process.execPath, args };
}

const EXTENSION_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MODEL_CONFIG_PATH = path.join(EXTENSION_DIR, "agents", "config.json");

function loadModelConfig(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveModelConfig(config: Record<string, string>): void {
  fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getAgentSystemPrompt(agentName: string): string {
  const locations = [
    path.join(EXTENSION_DIR, "agents", `${agentName}.md`),
    path.join(os.homedir(), ".pi", "agent", "agents", `${agentName}.md`),
    path.join(process.cwd(), ".pi", "agents", `${agentName}.md`),
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) return fs.readFileSync(loc, "utf-8");
  }
  return "";
}

async function writeTempPrompt(name: string, content: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-tim-"));
  const file = path.join(dir, `${name.replace(/[^\w.-]/g, "_")}.md`);
  await withFileMutationQueue(file, () => fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 }));
  return { dir, file };
}

function formatCost(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(4)}` : "";
}

// Format a token count as a human-readable string: 1234 → "1.2K", 1234567 → "1.2M"
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(u: AgentResult["usage"]): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns}t`);
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  const cost = formatCost(u.cost);
  if (cost) parts.push(cost);
  return parts.join(" ");
}

// ─── Core runner ──────────────────────────────────────────────────────────────

async function runAgent(
  cwd: string,
  agentName: string,
  task: string,
  signal: AbortSignal | undefined,
  onUpdate: (r: AgentResult) => void,
  model?: string,
  extraSystemPrompt?: string,
): Promise<AgentResult> {
  const systemPrompt = getAgentSystemPrompt(agentName) + (extraSystemPrompt ? `\n\n${extraSystemPrompt}` : "");
  const result: AgentResult = {
    agent: agentName,
    task,
    exitCode: 0,
    output: "",
    toolCalls: [],
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    running: true,
  };

  const args = ["--mode", "json", "-p", "--no-session", "--no-skills"];
  // use provided model, else fall back to config
  const resolvedModel = model || loadModelConfig()[agentName] || "";
  if (resolvedModel) args.push("--model", resolvedModel);
  // Restrict tool access per agent role:
  // - planner: explores codebase, read-only
  // - tukang: full access (implementor)
  // - riset: NOT restricted (may need bash/curl or extension tools for web research)
  const READ_ONLY_AGENTS: Record<string, string> = {
    planner: "read,ls,grep,find",
  };
  const toolAllowlist = READ_ONLY_AGENTS[agentName];
  if (toolAllowlist === "") args.push("--no-tools");
  else if (toolAllowlist) args.push("--tools", toolAllowlist);
  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  try {
    if (systemPrompt.trim()) {
      const tmp = await writeTempPrompt(agentName, systemPrompt);
      tmpDir = tmp.dir;
      tmpFile = tmp.file;
      args.push("--append-system-prompt", tmpFile);
    }
    args.push(`Task: ${task}`);

    const exitCode = await new Promise<number>((resolve) => {
      const inv = getPiCmd(args);
      const proc = spawn(inv.command, inv.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group so we can kill the whole tree
      });

      let buf = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }

        if (ev.type === "message_end" && ev.message) {
          const msg = ev.message;
          if (msg.role === "assistant") {
            result.usage.turns++;
            const u = msg.usage;
            if (u) {
              result.usage.input += u.input || 0;
              result.usage.output += u.output || 0;
              result.usage.cost += u.cost?.total || 0;
            }
            for (const part of msg.content ?? []) {
              if (part.type === "text") {
                result.output = part.text;
                if (part.text.trim()) {
                  result.toolCalls.push({ name: "text", args: {}, text: part.text.trim() });
                }
              }
              if (part.type === "toolCall") result.toolCalls.push({ name: part.name, args: part.arguments });
            }
          }
          onUpdate({ ...result });
        }

        if (ev.type === "tool_result_end" && ev.message) {
          onUpdate({ ...result });
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buf += data.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) processLine(l);
      });

      proc.stderr.on("data", (data: Buffer) => {
        result.error = (result.error ?? "") + data.toString();
      });

      proc.on("close", (code) => {
        if (buf.trim()) processLine(buf);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          try { process.kill(-proc.pid!, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
          setTimeout(() => {
            try { process.kill(-proc.pid!, "SIGKILL"); } catch { if (!proc.killed) proc.kill("SIGKILL"); }
          }, 3000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    result.running = false;
    onUpdate({ ...result });

    return result;
  } finally {
    if (tmpFile) try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

// ─── Parallel runner with concurrency limit ───────────────────────────────────

async function runParallel(
  items: Array<{ agent: string; task: string }>,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: (results: AgentResult[]) => void,
  concurrency = 4,
): Promise<AgentResult[]> {
  const results: AgentResult[] = items.map((item) => ({
    agent: item.agent,
    task: item.task,
    exitCode: -1,
    output: "",
    toolCalls: [],
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    running: true,
  }));

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await runAgent(cwd, items[i].agent, items[i].task, signal, (r) => {
        results[i] = r;
        onUpdate([...results]);
      });
      onUpdate([...results]);
    }
  });

  await Promise.all(workers);
  return results;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const AGENT_BADGE: Record<string, string> = {
  planner:               "📋",
  "scope-splitter":      "🗺️",
  riset:                 "🌐",
  tukang:                "🔨",
};

const AGENT_ROLE: Record<string, string> = {
  planner:        "planner",
  "scope-splitter": "scope-splitter",
  riset:          "riset",
  tukang:         "tukang",
};

function agentLabel(name: string, theme: any): string {
  const badge = AGENT_BADGE[name] ?? "•";
  const role  = AGENT_ROLE[name] ?? name;
  return `${badge} ${theme.fg("toolTitle", theme.bold(role))}`;
}

function taskScope(r: AgentResult): string {
  // Extract a short "what am I working on" label from the task string
  const t = r.task;
  const exploreMatch = t.match(/^Explore scope:\s*(.+)/m);
  if (exploreMatch) return `in ${exploreMatch[1].trim()}`;
  // Tukang format: "Scope: ..."
  const scopeMatch = t.match(/^Scope:\s*([^\n—]+)/m);
  if (scopeMatch) {
    const folder = scopeMatch[1].trim().replace(/\s*(directory|—).*$/i, "").trim();
    return `in ${folder}`;
  }
  // "Research best practices for: X"
  const researchMatch = t.match(/^Research best practices for:\s*(.+)/m);
  if (researchMatch) return researchMatch[1].trim().slice(0, 60);
  // "Subtask N: X"
  const subtaskMatch = t.match(/^Subtask \d+:\s*(.+)/m);
  if (subtaskMatch) return subtaskMatch[1].trim().slice(0, 60);
  // "Task: X"
  const taskMatch = t.match(/^Task:\s*(.+)/m);
  if (taskMatch) return taskMatch[1].trim().slice(0, 60);
  // fallback: first line
  return t.split("\n")[0].trim().slice(0, 60);
}

function totalUsage(results: AgentResult[]): string {
  const agg = results.reduce(
    (acc, r) => ({
      turns: acc.turns + r.usage.turns,
      input: acc.input + r.usage.input,
      output: acc.output + r.usage.output,
      cost: acc.cost + r.usage.cost,
    }),
    { turns: 0, input: 0, output: 0, cost: 0 },
  );
  const parts: string[] = [];
  if (agg.turns) parts.push(`${agg.turns} turn${agg.turns === 1 ? "" : "s"}`);
  if (agg.input) parts.push(`${formatTokens(agg.input)} in`);
  if (agg.output) parts.push(`${formatTokens(agg.output)} out`);
  if (agg.input || agg.output) parts.push(`${formatTokens(agg.input + agg.output)} total`);
  const cost = formatCost(agg.cost);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

// ─── Scope derivation (no agent — pure filesystem) ───────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache", "vendor"]);

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".java", ".rb", ".php", ".rs", ".swift", ".kt", ".cs",
  ".vue", ".svelte", ".c", ".cpp", ".h", ".hpp",
  ".md", ".prisma", ".sql", ".graphql", ".proto",
]);

/**
 * Recursively list all source files under a directory, skipping SKIP_DIRS.
 * Returns absolute paths. Caps at maxFiles to avoid huge prompts.
 */
function listSourceFiles(dir: string, maxFiles = 200): string[] {
  const result: string[] = [];
  const walk = (d: string) => {
    if (result.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (result.length >= maxFiles) return;
      if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) result.push(full);
      }
    }
  };
  walk(dir);
  return result;
}

/**
 * Merge subtasks whose scopes share any file path to prevent parallel conflicts.
 */
function mergeOverlappingSubtasks(subtasks: Array<{ subtask: string; scope: string }>): Array<{ subtask: string; scope: string }> {
  if (subtasks.length <= 1) return subtasks;

  const parseScope = (s: string): Set<string> =>
    new Set(s.split(",").map(p => p.trim().replace(/^[`'"]+|[`'"/]+$/g, "").trim()).filter(Boolean));

  const merged: Array<{ subtask: string; scope: Set<string> }> = subtasks.map(s => ({
    subtask: s.subtask,
    scope: parseScope(s.scope),
  }));

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const overlap = [...merged[i].scope].some(f => merged[j].scope.has(f));
        if (overlap) {
          merged[i].subtask += "; " + merged[j].subtask;
          merged[j].scope.forEach(f => merged[i].scope.add(f));
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return merged.map(m => ({ subtask: m.subtask, scope: [...m.scope].join(", ") }));
}

function buildExploreTask(cwd: string, scope: string, userTask: string, contextSuffix: string): string {
  // scope can be: "." (cwd), a dir name ("api"), comma-separated dirs ("api,web"),
  // or free-form text from the planner ("src/x.ts, src/y.ts", "entire codebase", etc).
  // Resolve to actual directories that exist. If a part is a file, use its parent dir.
  const resolveDirs = (s: string): string[] => {
    if (s === "." || s.trim() === "") return [cwd];
    const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
    const found = new Set<string>();
    for (const part of parts) {
      // Strip trailing slashes, quotes, or markdown backticks
      const cleaned = part.replace(/^[`'"]+|[`'"/]+$/g, "").trim();
      if (!cleaned) continue;
      const abs = path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned);
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) found.add(abs);
        else if (stat.isFile()) found.add(path.dirname(abs));
      } catch { /* path doesn't exist, skip */ }
    }
    return found.size > 0 ? Array.from(found) : [cwd];
  };

  const dirs = resolveDirs(scope);
  const scopeLabel = dirs.length === 1 && dirs[0] === cwd
    ? "."
    : dirs.map((d) => path.relative(cwd, d) || ".").join(" + ");

  // Collect files from all dirs in the scope
  const files: string[] = [];
  for (const d of dirs) {
    files.push(...listSourceFiles(d, 200));
    if (files.length >= 200) break;
  }

  // Prioritize markdown docs at the root of any scope directory — they usually
  // describe the project (README, guides, architecture notes, AGENTS etc.)
  const rootDirs = new Set(dirs);
  const isRootDoc = (p: string) =>
    p.toLowerCase().endsWith(".md") && rootDirs.has(path.dirname(p));
  files.sort((a, b) => {
    const ap = isRootDoc(a) ? 0 : 1;
    const bp = isRootDoc(b) ? 0 : 1;
    return ap - bp;
  });

  const rel = files.map((f) => path.relative(cwd, f));
  const fileList = rel.length > 0
    ? rel.slice(0, 200).map((f) => `- ${f}`).join("\n")
    : "(no source files detected in scope)";
  const truncatedNote = rel.length > 200 ? `\n... and ${rel.length - 200} more files` : "";

  return `Task: ${userTask}${contextSuffix}

FILES IN SCOPE (${rel.length} total):
${fileList}${truncatedNote}

From the file list above, identify which files need changes for the task. Output the list.`;
}

function deriveScopes(cwd: string, task: string): string[] {
  // Returns a list of scope identifiers. Each scope is either:
  //   - a single directory name (e.g. "api", "cms")
  //   - a comma-separated list of directory names (e.g. "api,server" for grouped scopes)
  //   - "." for the entire cwd (flat project or fallback)
  let entries: string[] = [];
  try {
    const all = fs.readdirSync(cwd).filter((e) => !SKIP_DIRS.has(e) && !e.startsWith("."));
    entries = all.filter((e) => fs.statSync(path.join(cwd, e)).isDirectory());
    if (entries.length === 0) return ["."];
  } catch { /* ignore */ }

  if (entries.length === 0) return ["."];

  // Step 0: direct path mentions in task — e.g. "fix bug in src/lib/auth.js" or "api/src/modules"
  // Walk through task tokens, look for anything that resolves to a real file or dir.
  const tokens = task.split(/[\s,()[\]{}`"']+/).filter((t) => t.length > 2 && /[/.]/.test(t));
  const pathMentions = new Set<string>();
  for (const token of tokens) {
    const cleaned = token.replace(/[.,;:]+$/, "").replace(/^[./]+/, "");
    if (!cleaned) continue;
    const abs = path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) pathMentions.add(path.dirname(abs));
      else if (stat.isDirectory()) pathMentions.add(abs);
    } catch { /* token isn't a real path */ }
  }
  if (pathMentions.size > 0) {
    return Array.from(pathMentions).map((p) => path.relative(cwd, p) || ".");
  }

  // Step 1: exact dir name mentions in task (e.g. "in the api")
  const mentionedDirs = entries.filter((e) => new RegExp(`\\b${e}\\b`, "i").test(task));
  if (mentionedDirs.length > 0) return mentionedDirs;

  // Step 2: semantic keyword matching — map task words to dir groups
  const apiDirs    = entries.filter((e) => /api|server|backend|routes|controllers|services/i.test(e));
  const clientDirs = entries.filter((e) => /client|frontend|web|app|pages|components|views|cms|admin/i.test(e));

  const wantsApi    = /\b(api|backend|server|route|endpoint|controller|service)\b/i.test(task);
  const wantsClient = /\b(cms|admin|frontend|web|client|ui|page|component|view)\b/i.test(task);

  const semanticDirs: string[] = [
    ...(wantsApi    ? apiDirs    : []),
    ...(wantsClient ? clientDirs : []),
  ];
  if (semanticDirs.length > 0) return semanticDirs;

  // If ≤6 top-level dirs, explore each separately
  if (entries.length <= 6) return entries;

  // Many dirs: group by common patterns — return as comma-separated dir lists
  const scopes: string[] = [];
  const api    = entries.filter((e) => /api|server|backend|routes|controllers|services/i.test(e));
  const client = entries.filter((e) => /client|frontend|web|app|pages|components|views|cms|admin/i.test(e));
  const shared = entries.filter((e) => !api.includes(e) && !client.includes(e));

  if (api.length)    scopes.push(api.join(","));
  if (client.length) scopes.push(client.join(","));
  if (shared.length) scopes.push(shared.join(","));

  // fallback: explore top-level dirs individually (up to 6 first)
  return scopes.length > 0 ? scopes : entries.slice(0, 6);
}

export default function (pi: ExtensionAPI) {
  // ── /tim-models inline renderer ────────────────────────────────────────────
  pi.registerMessageRenderer("tim-models-output", (message, _options, _theme) => {
    const text = message.content as string;
    return new Markdown(text, 0, 0, getMarkdownTheme());
  });

  // ── Update check on startup ────────────────────────────────────────────────
  pi.registerMessageRenderer("tim-changelog", (message, _options, _theme) => {
    return new Markdown(message.content as string, 0, 0, getMarkdownTheme());
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const cwd = EXTENSION_DIR;
      await pi.exec("git", ["fetch", "--quiet"], { cwd, timeout: 5000 }).catch(() => {});
      const local  = (await pi.exec("git", ["rev-parse", "HEAD"],         { cwd })).stdout.trim();
      const remote = (await pi.exec("git", ["rev-parse", "origin/master"], { cwd })).stdout.trim();
      if (local !== remote) {
        // get commits between local and remote
        const log = (await pi.exec(
          "git", ["log", "--oneline", `${local}..${remote}`], { cwd }
        )).stdout.trim();

        const lines = log.split("\n").filter(Boolean).slice(0, 10);
        const changelog = lines.map((l) => `- ${l}`).join("\n");

        pi.sendMessage({
          customType: "tim-changelog",
          content: `**tim update available** — run \`pi update\` then \`/reload\`\n\n**What's new:**\n${changelog}`,
          display: true,
        });
      }
    } catch { /* ignore */ }
  });
  pi.registerTool({
    name: "tim",
    label: "Tim",
    description: [
      "Orchestrate specialized subagents to complete development tasks.",
      "Modes: 'build' (planner → tukang[]), 'build-parallel' (planner → tukang[] parallel, no review), 'explore', 'research', 'implement', 'chain'.",
      "Use 'build-parallel' for big tasks.",
    ].join(" "),
    parameters: Type.Object({
      mode: StringEnum(["build", "build-parallel", "explore", "research", "implement", "chain"] as const, {
        description: "'build' implements with review gates. 'build-parallel' for big tasks (no review). 'explore' explores only. 'research' for web research. 'implement' runs tukang directly.",
      }),
      task: Type.String({ description: "The main task description" }),
      context: Type.Optional(Type.String({ description: "Additional context to pass to agents" })),
      scope: Type.Optional(Type.String({
        description: "Optional directory or comma-separated dirs to limit exploration (e.g. 'api' or 'api,cms/src/lib'). If omitted, tim auto-detects scopes from the task. Use this to reduce cost on small tasks or narrow focus.",
      })),
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({ description: "Agent name: planner, riset, or tukang" }),
            task: Type.String({ description: "Task, use {previous} to inject prior agent output" }),
          }),
          { description: "Custom chain steps (only for mode='chain')" },
        ),
      ),
    }),

    async execute(_id, params, toolSignal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const makeDetails = (results: AgentResult[]): TimDetails => ({ mode: params.mode, results });

      // combine tool-level abort + session-level abort — either one kills subagents
      const ac = new AbortController();
      const signal = ac.signal;
      const onAbort = () => ac.abort();
      if (toolSignal?.aborted || ctx.signal?.aborted) {
        ac.abort();
      } else {
        toolSignal?.addEventListener("abort", onAbort, { once: true });
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
      }
      const cleanupAbort = () => {
        toolSignal?.removeEventListener("abort", onAbort);
        ctx.signal?.removeEventListener("abort", onAbort);
      };

      const emit = (results: AgentResult[]) => {
        const running = results.filter((r) => r.running).map((r) => AGENT_BADGE[r.agent] ?? r.agent);
        if (running.length > 0) {
          ctx.ui.setStatus("tim", `tim: ${running.join(" ")} running…`);
        } else {
          ctx.ui.setStatus("tim", undefined);
        }
        onUpdate?.({
          content: [{ type: "text", text: results.find((r) => !r.running)?.output ?? "(running...)" }],
          details: makeDetails(results),
        });
      };

      // ── build: planner → tukang×N → review ────
      if (params.mode === "build") {
        const contextSuffix = params.context ? `\n\nAdditional context: ${params.context}` : "";

        // Step 1: planner explores codebase and splits into subtasks
        ctx.ui.setStatus("tim", "tim: 📋 planner — exploring & splitting…");
        const plannerResult = await runAgent(
          cwd, "planner",
          `Task: ${params.task}${contextSuffix}`,
          signal, (r) => emit([r]),
        );
        let allResults = [plannerResult];
        if (signal.aborted) { cleanupAbort(); ctx.ui.setStatus("tim", undefined); return { content: [{ type: "text", text: "(aborted)" }], details: makeDetails(allResults) }; }

        // Step 2: parse subtasks
        let subtasks: Array<{ subtask: string; scope: string }> = [];
        try {
          const json = plannerResult.output.match(/\[[\s\S]*\]/)?.[0] ?? plannerResult.output;
          subtasks = JSON.parse(json);
        } catch {
          subtasks = [{ subtask: params.task, scope: "." }];
        }
        subtasks = mergeOverlappingSubtasks(subtasks);

        ctx.ui.setStatus("tim", `tim: 🔨 tukang×${subtasks.length} — implementing…`);
        const tukangItems = subtasks.map((s, i) => ({
          agent: "tukang",
          task: [
            `Subtask ${i + 1}: ${s.subtask}`,
            `Scope: ${s.scope}`,
            "",
            "ONLY read and edit files listed in Scope above. Do NOT read other files.",
          ].join("\n"),
        }));

        const tukangResults = await runParallel(tukangItems, cwd, signal, (r) => emit([...allResults, ...r]));
        allResults = [...allResults, ...tukangResults];

        const implementation = tukangResults.map((r, i) => `### Subtask ${i + 1}\n${r.output}`).join("\n\n");

        cleanupAbort();
        ctx.ui.setStatus("tim", undefined);
        return {
          content: [{ type: "text", text: implementation || "(no output)" }],
          details: makeDetails(allResults),
        };
      }

      // ── build-parallel: planner → tukang×N (parallel) ──────
      if (params.mode === "build-parallel") {
        const contextSuffix = params.context ? `\n\nAdditional context: ${params.context}` : "";

        // Step 1: planner explores and splits
        ctx.ui.setStatus("tim", "tim: 📋 planner — exploring & splitting…");
        const plannerResult = await runAgent(
          cwd, "planner",
          `Task: ${params.task}${contextSuffix}`,
          signal, (r) => emit([r]),
        );
        let allResults = [plannerResult];
        if (signal.aborted) { cleanupAbort(); ctx.ui.setStatus("tim", undefined); return { content: [{ type: "text", text: "(aborted)" }], details: makeDetails(allResults) }; }

        let subtasks: Array<{ subtask: string; scope: string }> = [];
        try {
          const json = plannerResult.output.match(/\[[\s\S]*\]/)?.[0] ?? plannerResult.output;
          subtasks = JSON.parse(json);
        } catch {
          subtasks = [{ subtask: params.task, scope: "entire codebase" }];
        }

        // Merge subtasks that share files in scope to prevent conflicts
        subtasks = mergeOverlappingSubtasks(subtasks);

        // Step 3: tukang×N in parallel
        const tukangItems = subtasks.map((s, i) => ({
          agent: "tukang",
          task: [
            `Subtask ${i + 1}: ${s.subtask}`,
            `Scope: ${s.scope}`,
            "",
            "ONLY read and edit files listed in Scope above. Do NOT read other files.",
          ].join("\n"),
        }));

        const tukangResults = await runParallel(tukangItems, cwd, signal, (r) => emit([...allResults, ...r]));
        allResults = [...allResults, ...tukangResults];

        ctx.ui?.setStatus?.("tim", undefined);
        const finalOutput = tukangResults.map((r, i) => `### Subtask ${i + 1}\n${r.output}`).join("\n\n");
        cleanupAbort();
        return {
          content: [{ type: "text", text: finalOutput || "(no output)" }],
          details: makeDetails(allResults),
        };
      }

      // ── single agent modes ─────────────────────────────────────────────────
      const singleAgentMap: Record<string, string> = {
        implement: "tukang",
      };

      // explore = planner[] in parallel across scopes
      if (params.mode === "explore") {
        const contextSuffix = params.context ? `\n\nAdditional context: ${params.context}` : "";
        const scopes = params.scope ? params.scope.split(",").map(s => s.trim()).filter(Boolean) : deriveScopes(cwd, params.task);
        const items = scopes.map((scope) => ({
          agent: "planner",
          task: buildExploreTask(cwd, scope, params.task, contextSuffix),
        }));
        const results = await runParallel(items, cwd, signal, emit);
        const combined = results.map((r) => r.output).filter(Boolean).join("\n\n---\n\n");
        ctx.ui.setStatus("tim", undefined);
        cleanupAbort();
        return {
          content: [{ type: "text", text: combined || "(no output)" }],
          details: makeDetails(results),
        };
      }

      // research = riset[] in parallel (web research across scopes)
      if (params.mode === "research") {
        const contextSuffix = params.context ? `\n\nAdditional context: ${params.context}` : "";
        const scopes = params.scope ? params.scope.split(",").map(s => s.trim()).filter(Boolean) : deriveScopes(cwd, params.task);
        const items = scopes.map((scope) => ({
          agent: "riset",
          task: `Research best practices for: ${params.task}${contextSuffix}\n\nFocus area: ${scope}`,
        }));
        const results = await runParallel(items, cwd, signal, emit);
        const combined = results.map((r) => r.output).filter(Boolean).join("\n\n---\n\n");
        ctx.ui.setStatus("tim", undefined);
        cleanupAbort();
        return {
          content: [{ type: "text", text: combined || "(no output)" }],
          details: makeDetails(results),
        };
      }

      if (params.mode in singleAgentMap) {
        const agentName = singleAgentMap[params.mode];
        const task = params.context ? `${params.task}\n\nContext: ${params.context}` : params.task;
        const result = await runAgent(cwd, agentName, task, signal, (r) => emit([r]));
        cleanupAbort();
        return {
          content: [{ type: "text", text: result.output || "(no output)" }],
          details: makeDetails([result]),
        };
      }

      // ── chain: custom sequential ───────────────────────────────────────────
      if (params.mode === "chain") {
        const steps = params.chain ?? [];
        if (steps.length === 0) {
          return {
            content: [{ type: "text", text: "chain mode requires a 'chain' array of steps" }],
            details: makeDetails([]),
          };
        }

        const results: AgentResult[] = [];
        let previous = "";

        for (const step of steps) {
          if (signal.aborted) break;
          const task = step.task.replace(/\{previous\}/g, previous);
          const result = await runAgent(cwd, step.agent, task, signal, (r) => emit([...results, r]));
          results.push(result);

          if (result.exitCode !== 0) {
            cleanupAbort();
            return {
              content: [{ type: "text", text: `Chain stopped at ${step.agent}: ${result.error ?? result.output}` }],
              details: makeDetails(results),
              isError: true,
            };
          }
          previous = result.output;
        }

        cleanupAbort();
        return {
          content: [{ type: "text", text: previous || "(no output)" }],
          details: makeDetails(results),
        };
      }

      cleanupAbort();
      return {
        content: [{ type: "text", text: `Unknown mode: ${params.mode}` }],
        details: makeDetails([]),
        isError: true,
      };
    },

    renderCall(args, theme) {
      const modeColors: Record<string, string> = {
        "build": "success", "build-parallel": "accent",
        "explore": "muted", "research": "muted", "implement": "muted", "chain": "muted",
      };
      const modeIcons: Record<string, string> = {
        "build": "⚡", "build-parallel": "⚡⚡",
        "explore": "🔍", "research": "🌐", "implement": "🔨", "chain": "⛓",
      };

      const icon = modeIcons[args.mode] ?? "•";
      const color = modeColors[args.mode] ?? "muted";
      const preview = args.task.length > 70 ? args.task.slice(0, 70) + "…" : args.task;

      let flow = "";
      if (args.mode === "build")          flow = "planner  →  tukang[]";
      else if (args.mode === "build-parallel") flow = "planner  →  tukang[]";
      else if (args.mode === "chain" && args.chain)
        flow = args.chain.map((s: any) => s.agent).join("  →  ");

      let text =
        `${icon}  ` +
        theme.fg("toolTitle", theme.bold("tim")) +
        "  " +
        theme.fg(color, args.mode) +
        `\n   ${theme.fg("dim", preview)}`;

      if (flow) text += `\n   ${theme.fg("muted", flow)}`;

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as TimDetails | undefined;
      if (!details || details.results.length === 0) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
      }

      const allResults = details.results;
      const running    = allResults.some((r) => r.running);
      const allOk      = allResults.every((r) => r.exitCode === 0);

      // ── header ─────────────────────────────────────────────────────────────
      const running = allResults.some((r) => r.running);
      const allOk   = allResults.every((r) => r.exitCode === 0);

      // ── header ─────────────────────────────────────────────────────────────
      const statusIcon = running
        ? theme.fg("warning", "◌")
        : allOk ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const header = `${statusIcon}  ${theme.fg("toolTitle", theme.bold("tim"))}  ${theme.fg("accent", details.mode)}`;

      // ── expanded view ───────────────────────────────────────────────────────
      if (expanded) {
        const container = new Container();
        container.addChild(new Text(header, 0, 0));
        for (const r of allResults) {
          container.addChild(new Spacer(1));
          const icon = r.running ? theme.fg("warning", "◌") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          container.addChild(new Text(
            `${icon}  ${agentLabel(r.agent, theme)}  ${theme.fg("dim", formatUsage(r.usage))}`,
            0, 0,
          ));
          if (r.exitCode !== 0 && r.error) {
            container.addChild(new Text(`   ${theme.fg("error", r.error.trim().slice(0, 200))}`, 0, 0));
          } else if (r.output) {
            container.addChild(new Markdown(r.output.trim(), 2, 0, getMarkdownTheme()));
          }
        }
        const cost = totalUsage(allResults);
        if (cost && !running) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", cost), 0, 0));
        }
        return container;
      }

      // ── collapsed / live view ───────────────────────────────────────────────
      const container = new Container();
      container.addChild(new Text(header, 0, 0));

      const cwd_ = process.cwd();
      for (const r of allResults) {
        const icon = r.running
          ? theme.fg("warning", "◌")
          : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");

        // current action: last tool call or last text
        let action = "";
        if (r.running) {
          const last = [...r.toolCalls].reverse().find(tc => tc.name !== "text") ;
          const lastText = [...r.toolCalls].reverse().find(tc => tc.name === "text");
          if (lastText?.text) {
            const line = lastText.text.split("\n").find(l => l.trim()) ?? "";
            action = theme.fg("dim", line.slice(0, 80));
          } else if (last) {
            const arg = last.args.path
              ? String(last.args.path).replace(cwd_, "").replace(/^\//, "")
              : last.args.pattern ? `"${String(last.args.pattern).slice(0, 30)}"`
              : last.args.command ? String(last.args.command).replace(cwd_, "~").slice(0, 50)
              : "";
            action = theme.fg("dim", `${last.name}${arg ? "  " + arg : ""}`);
          } else {
            action = theme.fg("muted", "…");
          }
        } else if (r.exitCode !== 0) {
          action = theme.fg("error", (r.error ?? "failed").trim().slice(0, 80));
        } else {
          // done: last AI text as summary
          const lastText = [...r.toolCalls].reverse().find(tc => tc.name === "text");
          const line = lastText?.text?.split("\n").find(l => l.trim()) ?? r.output?.split("\n").find(l => l.trim()) ?? "";
          action = theme.fg("dim", line.slice(0, 80));
        }

        const usage = !r.running && r.usage.cost ? theme.fg("dim", `  ${formatCost(r.usage.cost)}`) : "";
        container.addChild(new Text(
          `  ${icon}  ${agentLabel(r.agent, theme)}  ${action}${usage}`,
          0, 0,
        ));
      }

      const cost = totalUsage(allResults);
      if (cost && !running) container.addChild(new Text(`  ${theme.fg("dim", cost)}`, 0, 0));

      return container;
    },
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (/tim.*mode=|mode="(build|plan|research)|tim-invoke/i.test(event.prompt)) {
      return {
        systemPrompt: event.systemPrompt +
          "\n\nCRITICAL: You MUST call the tim tool RIGHT NOW with the exact parameters in the message. Do NOT explain, do NOT show JSON, do NOT say 'I will', do NOT think out loud. Just call the tool immediately.",
      };
    }
  });

  // Convenience command: /tim <task>
  pi.registerCommand("tim", {
    description: "Run tim build workflow: planner → tukang",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /tim <task description>", "info");
        return;
      }
      await ctx.waitForIdle();
      pi.sendMessage(
        {
          customType: "tim-invoke",
          content: `[tim-invoke] CALL TIM TOOL NOW. mode="build" task="${args.trim()}"`,
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("tim-riset", {
    description: "Run riset (web research) in parallel across scopes — no implementation",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /tim-riset <task description>", "info");
        return;
      }
      await ctx.waitForIdle();
      pi.sendMessage(
        {
          customType: "tim-invoke",
          content: `[tim-invoke] CALL TIM TOOL NOW. mode="research" task="${args.trim()}"`,
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("tim-init", {
    description: "Generate PROJECT_STRUCTURE.md — a codebase map to speed up planner",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const scopes = deriveScopes(cwd, "");

      const lines: string[] = ["# Project Structure\n"];

      for (const scope of scopes) {
        const scopeDir = path.isAbsolute(scope) ? scope : path.join(cwd, scope);
        const rel = path.relative(cwd, scopeDir) || ".";
        lines.push(`## ${rel}/\n`);

        // Build tree
        const buildTree = (dir: string, prefix: string, depth: number): void => {
          if (depth > 3) return;
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."));
          const files = entries.filter(e => e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase()));

          for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
            lines.push(`${prefix}${d.name}/`);
            buildTree(path.join(dir, d.name), prefix + "  ", depth + 1);
          }
          for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
            lines.push(`${prefix}${f.name}`);
          }
        };

        buildTree(scopeDir, "  ", 0);
        lines.push("");
      }

      const outPath = path.join(cwd, "PROJECT_STRUCTURE.md");
      fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
      ctx.ui.notify(`Created ${outPath}`, "info");
    },
  });

  // ── Model config commands ──────────────────────────────────────────────────
  const AGENTS = ["tukang", "planner"] as const;

  pi.registerCommand("tim-models", {
    description: "Show current model config for each tim agent",
    handler: (_args, _ctx) => {
      const config = loadModelConfig();
      const rows = AGENTS.map((a) => {
        const model = config[a] || "(default)";
        const badge = AGENT_BADGE[a] ?? "•";
        const pad   = " ".repeat(Math.max(1, 28 - a.length));
        return `  ${badge} \`${a}\`${pad}${model}`;
      }).join("\n");
      pi.sendMessage({
        customType: "tim-models-output",
        content: `**Tim agent models:**\n${rows}`,
        display: true,
      });
    },
  });

  for (const agent of AGENTS) {
    pi.registerCommand(`tim-set-${agent}`, {
      description: `Pick model for ${AGENT_BADGE[agent]} ${agent}`,
      handler: async (args, ctx) => {
        // If model passed directly as arg, use it
        if (args?.trim()) {
          const config = loadModelConfig();
          config[agent] = args.trim();
          saveModelConfig(config);
          ctx.ui.notify(`${AGENT_BADGE[agent]} ${agent} → ${args.trim()}`, "info");
          return;
        }

        // Otherwise show picker
        const models = ctx.modelRegistry.getAvailable() ?? [];
        const current = loadModelConfig()[agent] || "";

        const items: SelectItem[] = [
          { value: "", label: "(default)", description: "use Pi's active model" },
          ...models.map((m: any) => ({
            value: `${m.provider}/${m.id}`,
            label: m.name ?? m.id,
            description: m.provider,
          })),
        ];

        const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(
            `${AGENT_BADGE[agent]}  ${theme.fg("accent", theme.bold(`Model for ${agent}`))}`,
            1, 0,
          ));

          // Search input
          const searchInput = new Input();
          const searchLabel = new Text(theme.fg("dim", "Search: "), 1, 0);
          container.addChild(searchLabel);
          container.addChild(searchInput);
          container.addChild(new Spacer(1));

          const list = new SelectList(items, 4, {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText:   (t) => theme.fg("accent", t),
            description:    (t) => theme.fg("muted", t),
            scrollInfo:     (t) => theme.fg("dim", t),
            noMatch:        (t) => theme.fg("warning", t),
          });
          // pre-select current
          const idx = items.findIndex((i) => i.value === current);
          if (idx > 0) list.setSelectedIndex(idx);

          list.onSelect = (item) => done(item.value as string);
          list.onCancel = () => done(null);
          searchInput.onEscape = () => done(null);

          container.addChild(list);
          container.addChild(new Text(theme.fg("dim", "↑↓ scroll • enter select • esc cancel"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          // focus tracking: search input gets text, arrows go to list
          let searchFocused = true;
          searchInput.focused = true;

          return {
            render:     (w) => container.render(w),
            invalidate: ()  => container.invalidate(),
            handleInput: (data) => {
              const isArrow = data === "\x1b[A" || data === "\x1b[B";
              if (isArrow) {
                searchFocused = false;
                searchInput.focused = false;
                list.handleInput(data);
              } else if (data === "\r") {
                list.handleInput(data);
              } else {
                searchFocused = true;
                searchInput.focused = true;
                searchInput.handleInput(data);
                list.setFilter(searchInput.getValue());
              }
              tui.requestRender();
            },
          };
        });

        if (picked == null) return; // cancelled

        const config = loadModelConfig();
        config[agent] = picked === "(default)" ? "" : picked;
        saveModelConfig(config);
        ctx.ui.notify(
          picked === "(default)" || picked === ""
            ? `${AGENT_BADGE[agent]} ${agent} reset to default`
            : `${AGENT_BADGE[agent]} ${agent} → ${picked}`,
          "info",
        );
      },
    });
  }
}
