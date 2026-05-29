import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, relative } from "node:path";
import traverseModule, { type NodePath, type TraverseOptions } from "@babel/traverse";
import * as t from "@babel/types";
import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import { fail } from "./errors.js";

const traverseAst = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (
  parent: t.Node,
  opts: TraverseOptions,
) => void;

export type FileLengthThresholds = {
  info: number;
  warn: number;
  urgent: number;
};

export type QualityConfig = {
  fileLengthThresholds: FileLengthThresholds;
  maxExtractProps: number;
  defaultWrite: "auto" | "true" | "false";
  defaultOutput: "auto" | "compact" | "detailed";
};

export type FileLengthWarning = {
  code: "FILE_LENGTH_INFO" | "FILE_LENGTH_WARN" | "FILE_LENGTH_URGENT";
  level: "info" | "warn" | "urgent";
  file: string;
  previous_lines: number;
  next_lines: number;
  threshold: number;
  message: string;
  next_step_hint: string;
};

export type StateCluster = {
  name: string;
  states: string[];
  handlers: string[];
  recommendation: "custom-hook" | "context" | "keep-local";
  confidence: "high" | "medium" | "low";
  reason: string;
  extract_to?: string;
};

export type StateAnalysis = {
  success: true;
  file: string;
  states_total: number;
  handlers_total: number;
  clusters: StateCluster[];
  guidance?: StateAnalysisGuidance[];
  ambiguous: Array<{
    states: string[];
    candidates: string[];
    resolution: string;
  }>;
  ungrouped: string[];
  summary: {
    auto_decidable: string;
    user_input_needed: string;
  };
};

export type StateAnalysisGuidance = {
  code: "STATE_CLUSTER_TOO_LARGE";
  cluster: string;
  states_count: number;
  handlers_count: number;
  large_handlers: Array<{ name: string; states_count: number }>;
  message: string;
  suggestions: string[];
  suggested_subclusters: Array<{ name: string; states: string[]; handlers: string[] }>;
  next_step_hint: string;
};

type StateBinding = {
  name: string;
  setter: string;
  order: number;
};

type HandlerUsage = {
  name: string;
  reads: Set<string>;
  writes: Set<string>;
};

const GIANT_CLUSTER_STATE_THRESHOLD = 8;
const LARGE_HANDLER_STATE_THRESHOLD = 8;

const DEFAULT_CONFIG: QualityConfig = {
  fileLengthThresholds: {
    info: 500,
    warn: 1000,
    urgent: 2000,
  },
  maxExtractProps: 12,
  defaultWrite: "auto",
  defaultOutput: "auto",
};

export function loadQualityConfig(filePath?: string): QualityConfig {
  const configPath = findConfigPath(filePath);
  if (!configPath) return DEFAULT_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    fail("INVALID_TEDIT_CONFIG", `Invalid tedit config at ${configPath}.`, {
      parser_error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_CONFIG;
  const data = parsed as Record<string, unknown>;
  const thresholds = normalizeThresholds(data.file_length_thresholds ?? data.fileLengthThresholds);
  const maxExtractProps = normalizePositiveInteger(data.max_extract_props ?? data.maxExtractProps, DEFAULT_CONFIG.maxExtractProps);
  const defaultWrite = normalizeDefaultWrite(data.defaultWrite ?? data.default_write, DEFAULT_CONFIG.defaultWrite);
  const defaultOutput = normalizeDefaultOutput(outputDefaultValue(data), DEFAULT_CONFIG.defaultOutput);
  return { fileLengthThresholds: thresholds, maxExtractProps, defaultWrite, defaultOutput };
}

export function fileLengthWarnings(filePath: string, previous: string, next: string): FileLengthWarning[] {
  const thresholds = loadQualityConfig(filePath).fileLengthThresholds;
  const previousLines = countLines(previous);
  const nextLines = countLines(next);
  const levels: Array<{ level: FileLengthWarning["level"]; code: FileLengthWarning["code"]; threshold: number }> = [
    { level: "info", code: "FILE_LENGTH_INFO", threshold: thresholds.info },
    { level: "warn", code: "FILE_LENGTH_WARN", threshold: thresholds.warn },
    { level: "urgent", code: "FILE_LENGTH_URGENT", threshold: thresholds.urgent },
  ];

  return levels
    .filter(({ threshold }) => previousLines < threshold && nextLines >= threshold)
    .map(({ level, code, threshold }) => ({
      code,
      level,
      file: filePath,
      previous_lines: previousLines,
      next_lines: nextLines,
      threshold,
      message: `${filePath} is now ${nextLines} lines; ${fileLengthMessage(level)}.`,
      next_step_hint: "Run tedit analyze-state or consider extracting a smaller structural unit before adding more code.",
    }));
}

export function formatFileLengthWarnings(warnings: FileLengthWarning[]): string {
  if (warnings.length === 0) return "";
  return warnings.map((warning) => {
    return `tedit: ${warning.message}\n  Suggested next step: ${warning.next_step_hint}`;
  }).join("\n");
}

export function analyzeState(filePath: string, source = readFileSync(filePath, "utf8")): StateAnalysis {
  const ast = recast.parse(source, { parser: babelTsParser }) as unknown as t.File;
  const states = collectStateBindings(ast);
  const usages = collectHandlerUsages(ast, states);
  const clusters = buildStateClusters(filePath, states, usages);
  const guidance = stateAnalysisGuidance(clusters, usages);
  const ungrouped = clusters.filter((cluster) => cluster.recommendation === "keep-local").flatMap((cluster) => cluster.states);
  const autoDecidable = clusters.filter((cluster) => cluster.confidence !== "low").length;

  return {
    success: true,
    file: filePath,
    states_total: states.size,
    handlers_total: usages.size,
    clusters,
    ...(guidance.length > 0 ? { guidance } : {}),
    ambiguous: [],
    ungrouped,
    summary: {
      auto_decidable: `${autoDecidable} / ${clusters.length} clusters`,
      user_input_needed: "0 ambiguous",
    },
  };
}

function findConfigPath(filePath?: string): string | null {
  let current = filePath ? configSearchStart(filePath) : process.cwd();
  while (true) {
    const candidate = join(current, ".tedit", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function configSearchStart(filePath: string): string {
  return existsSync(join(filePath, ".tedit", "config.json")) ? filePath : dirname(filePath);
}

function normalizeThresholds(value: unknown): FileLengthThresholds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CONFIG.fileLengthThresholds;
  const input = value as Record<string, unknown>;
  const info = normalizePositiveInteger(input.info, DEFAULT_CONFIG.fileLengthThresholds.info);
  const warn = normalizePositiveInteger(input.warn, DEFAULT_CONFIG.fileLengthThresholds.warn);
  const urgent = normalizePositiveInteger(input.urgent, DEFAULT_CONFIG.fileLengthThresholds.urgent);
  if (!(info <= warn && warn <= urgent)) {
    fail("INVALID_TEDIT_CONFIG", "file_length_thresholds must satisfy info <= warn <= urgent.");
  }
  return { info, warn, urgent };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail("INVALID_TEDIT_CONFIG", "Quality config numeric thresholds must be positive integers.");
  }
  return parsed;
}

function normalizeDefaultWrite(value: unknown, fallback: QualityConfig["defaultWrite"]): QualityConfig["defaultWrite"] {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  if (value === "auto") return "auto";
  fail("INVALID_TEDIT_CONFIG", "defaultWrite must be true, false, or auto.");
}

function outputDefaultValue(data: Record<string, unknown>): unknown {
  if (data.defaultOutput !== undefined || data.default_output !== undefined) {
    return data.defaultOutput ?? data.default_output;
  }
  const output = data.output;
  if (output === undefined) return undefined;
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    fail("INVALID_TEDIT_CONFIG", "output must be compact, detailed, auto, or an object with defaultMode.");
  }
  const record = output as Record<string, unknown>;
  return record.defaultMode ?? record.default_mode ?? record.default ?? record.mode;
}

function normalizeDefaultOutput(value: unknown, fallback: QualityConfig["defaultOutput"]): QualityConfig["defaultOutput"] {
  if (value === undefined) return fallback;
  if (value === "compact" || value === "detailed" || value === "auto") return value;
  fail("INVALID_TEDIT_CONFIG", "output.defaultMode must be compact, detailed, or auto.");
}

function fileLengthMessage(level: FileLengthWarning["level"]): string {
  if (level === "info") return "consider splitting";
  if (level === "warn") return "splitting recommended";
  return "splitting urgent";
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split(/\r?\n/).length;
}

function collectStateBindings(ast: t.File): Map<string, StateBinding> {
  const states = new Map<string, StateBinding>();
  traverseAst(ast, {
    VariableDeclarator(path) {
      const node = path.node;
      if (!t.isArrayPattern(node.id) || !node.init || !isUseStateCall(node.init)) return;
      const [stateNode, setterNode] = node.id.elements;
      if (!t.isIdentifier(stateNode) || !t.isIdentifier(setterNode)) return;
      states.set(stateNode.name, {
        name: stateNode.name,
        setter: setterNode.name,
        order: states.size,
      });
    },
  });
  return states;
}

function collectHandlerUsages(ast: t.File, states: Map<string, StateBinding>): Map<string, HandlerUsage> {
  const setterToState = new Map([...states.values()].map((state) => [state.setter, state.name]));
  const usages = new Map<string, HandlerUsage>();

  const usageFor = (path: NodePath<t.Node>): HandlerUsage => {
    const name = nearestHandlerName(path) ?? "render";
    let usage = usages.get(name);
    if (!usage) {
      usage = { name, reads: new Set(), writes: new Set() };
      usages.set(name, usage);
    }
    return usage;
  };

  traverseAst(ast, {
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const state = states.get(path.node.name);
      if (!state) return;
      usageFor(path).reads.add(state.name);
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const stateName = setterToState.get(callee.name);
      if (!stateName) return;
      usageFor(path).writes.add(stateName);
    },
  });

  return usages;
}

function buildStateClusters(filePath: string, states: Map<string, StateBinding>, usages: Map<string, HandlerUsage>): StateCluster[] {
  const graph = new Map<string, Set<string>>();
  for (const state of states.keys()) graph.set(state, new Set());

  for (const usage of usages.values()) {
    const names = [...new Set([...usage.reads, ...usage.writes])];
    for (const left of names) {
      for (const right of names) {
        if (left !== right) graph.get(left)?.add(right);
      }
    }
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  const orderedStates = [...states.values()].sort((a, b) => a.order - b.order).map((state) => state.name);
  for (const state of orderedStates) {
    if (seen.has(state)) continue;
    const stack = [state];
    const component: string[] = [];
    seen.add(state);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      component.push(current);
      for (const next of graph.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(component.sort((a, b) => (states.get(a)?.order ?? 0) - (states.get(b)?.order ?? 0)));
  }

  return components.map((component) => {
    const handlers = [...usages.values()]
      .filter((usage) => component.some((state) => usage.reads.has(state) || usage.writes.has(state)))
      .map((usage) => usage.name)
      .filter((name, index, names) => names.indexOf(name) === index);
    const name = deriveClusterName(component);
    const isGiant = component.length > GIANT_CLUSTER_STATE_THRESHOLD;
    const recommendation = component.length === 1 ? "keep-local" : isGiant ? "context" : "custom-hook";
    const confidence = isGiant ? "low" : component.length > 1 && handlers.length > 0 ? "high" : "medium";
    return {
      name,
      states: component,
      handlers,
      recommendation,
      confidence,
      reason: clusterReason(component, handlers, recommendation),
      ...(recommendation === "custom-hook" ? { extract_to: suggestHookPath(filePath, name) } : {}),
    };
  });
}

function stateAnalysisGuidance(clusters: StateCluster[], usages: Map<string, HandlerUsage>): StateAnalysisGuidance[] {
  return clusters
    .filter((cluster) => cluster.states.length > GIANT_CLUSTER_STATE_THRESHOLD)
    .map((cluster) => {
      const suggestedSubclusters = suggestStateSubclusters(cluster, usages);
      const largeHandlers = cluster.handlers
        .map((name) => {
          const usage = usages.get(name);
          const statesCount = usage ? new Set([...usage.reads, ...usage.writes]).size : 0;
          return { name, states_count: statesCount };
        })
        .filter((handler) => handler.states_count >= LARGE_HANDLER_STATE_THRESHOLD)
        .sort((left, right) => right.states_count - left.states_count || left.name.localeCompare(right.name));
      return {
        code: "STATE_CLUSTER_TOO_LARGE" as const,
        cluster: cluster.name,
        states_count: cluster.states.length,
        handlers_count: cluster.handlers.length,
        large_handlers: largeHandlers,
        message: `${cluster.name} contains ${cluster.states.length} states; broad handlers may be collapsing unrelated domains into one cluster.`,
        suggestions: [
          "Inspect large_handlers for bootstrap/init/render handlers that touch many states.",
          "Refactor suggested_subclusters first when they map to clear UI or domain boundaries.",
          "Split broad initialization handlers before applying refactor-state to the whole cluster.",
        ],
        suggested_subclusters: suggestedSubclusters,
        next_step_hint: suggestedSubclusters.length > 1
          ? `Consider extracting ${suggestedSubclusters[0].name} first; it has ${suggestedSubclusters[0].states.length} state(s).`
          : largeHandlers.length > 0
            ? `Review ${largeHandlers[0].name}; it touches ${largeHandlers[0].states_count} states and may dominate clustering.`
            : "Review handlers that read/write many states before applying refactor-state.",
      };
    });
}

function suggestStateSubclusters(cluster: StateCluster, usages: Map<string, HandlerUsage>): Array<{ name: string; states: string[]; handlers: string[] }> {
  const groups = new Map<string, string[]>();
  for (const state of cluster.states) {
    const domain = stateDomainName(state);
    const list = groups.get(domain) ?? [];
    list.push(state);
    groups.set(domain, list);
  }
  return [...groups.entries()]
    .filter(([, states]) => states.length > 0)
    .map(([name, states]) => ({
      name,
      states,
      handlers: cluster.handlers.filter((handler) => {
        const usage = usages.get(handler);
        return !!usage && states.some((state) => usage.reads.has(state) || usage.writes.has(state));
      }),
    }))
    .sort((left, right) => right.states.length - left.states.length || left.name.localeCompare(right.name));
}

function stateDomainName(state: string): string {
  const segments = state.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
  if (!segments || segments.length <= 1) return state;
  return segments.slice(0, -1).join("");
}

function isUseStateCall(node: t.Node): boolean {
  if (!t.isCallExpression(node)) return false;
  if (t.isIdentifier(node.callee)) return node.callee.name === "useState";
  return t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: "React" }) &&
    t.isIdentifier(node.callee.property, { name: "useState" });
}

function nearestHandlerName(path: NodePath<t.Node>): string | null {
  let current: NodePath<t.Node> | null = path;
  while (current) {
    if (current.isFunctionDeclaration()) return current.node.id?.name ?? "anonymousFunction";
    if (current.isFunctionExpression() || current.isArrowFunctionExpression()) {
      const parent = current.parentPath;
      if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return parent.node.id.name;
      if (parent?.isObjectProperty() && t.isIdentifier(parent.node.key)) return parent.node.key.name;
      return "anonymousFunction";
    }
    current = current.parentPath;
  }
  return null;
}

function deriveClusterName(states: string[]): string {
  if (states.length === 1) return states[0];
  const prefix = commonCamelPrefix(states);
  if (prefix.length >= 3) return prefix;
  return `${states[0]}Cluster`;
}

function commonCamelPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index++;
    prefix = prefix.slice(0, index);
  }
  const isCompleteSegment = values.every((value) => {
    const next = value[prefix.length];
    return next === undefined || /[A-Z_$]/.test(next);
  });
  return (isCompleteSegment ? prefix : prefix.replace(/[A-Z][a-z0-9_]*$/, "")).replace(/[^A-Za-z0-9_$]+$/, "");
}

function clusterReason(states: string[], handlers: string[], recommendation: StateCluster["recommendation"]): string {
  if (recommendation === "keep-local") return "single state; no clustering pressure detected";
  return `${states.length} states are co-read or co-written across ${handlers.length} handler(s)`;
}

function suggestHookPath(filePath: string, clusterName: string): string {
  const parsed = parse(filePath);
  const hookFile = `use-${kebabCase(clusterName)}.ts`;
  const target = join(parsed.dir, hookFile);
  return relative(process.cwd(), target) || target;
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
