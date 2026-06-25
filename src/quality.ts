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

export type ClassNameConflictConfig = {
  enabled: boolean;
  groups: Record<string, string[]>;
};

export type QualityConfig = {
  fileLengthThresholds: FileLengthThresholds;
  classNameConflicts: ClassNameConflictConfig;
  maxExtractProps: number;
  defaultWrite: "auto" | "true" | "false";
  defaultOutput: "auto" | "compact" | "detailed";
  diffMode: "off" | "stats" | "auto" | "full";
  inlineDiffMaxBytes: number;
  inlineDiffMaxHunks: number;
  diffArtifactDir: string;
  diffArtifacts?: boolean;
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

export type ClassNameConflictWarning = {
  code: "CLASSNAME_CONFLICT";
  level: "warn";
  file: string;
  element: string;
  attribute: "className" | "class";
  group: string;
  classes: string[];
  message: string;
  next_step_hint: string;
  line?: number;
  column?: number;
  variant?: string;
};

export type QualityWarning = FileLengthWarning | ClassNameConflictWarning;

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

type ClassToken = {
  value: string;
  exclusiveGroup?: string;
  branch?: "consequent" | "alternate";
};

type ClassEffect = {
  group: string;
  family: string;
  axes: string[];
};

type ClassTokenEffect = ClassToken & {
  effect: ClassEffect;
};

const GIANT_CLUSTER_STATE_THRESHOLD = 8;
const LARGE_HANDLER_STATE_THRESHOLD = 8;

const AXIS_ALL = ["all"];
const BOX_AXES = ["top", "right", "bottom", "left"];
const AXIS_X = ["right", "left"];
const AXIS_Y = ["top", "bottom"];
const CORNER_AXES = ["top-left", "top-right", "bottom-right", "bottom-left"];
const TEXT_SIZE_CLASSES = new Set([
  "text-xs",
  "text-sm",
  "text-base",
  "text-lg",
  "text-xl",
  "text-2xl",
  "text-3xl",
  "text-4xl",
  "text-5xl",
  "text-6xl",
  "text-7xl",
  "text-8xl",
  "text-9xl",
]);
const TEXT_ALIGN_CLASSES = new Set(["text-left", "text-center", "text-right", "text-justify", "text-start", "text-end"]);
const TEXT_NON_COLOR_CLASSES = new Set([
  ...TEXT_ALIGN_CLASSES,
  "text-balance",
  "text-pretty",
  "text-wrap",
  "text-nowrap",
  "text-ellipsis",
  "text-clip",
]);
const BORDER_WIDTH_VALUES = new Set(["0", "2", "4", "8"]);
const ROUNDED_VALUES = new Set(["none", "sm", "md", "lg", "xl", "2xl", "3xl", "full"]);

const DEFAULT_CLASS_GROUPS: Record<string, string[]> = {
  width: ["w-"],
  "min-width": ["min-w-"],
  "max-width": ["max-w-"],
  height: ["h-"],
  "min-height": ["min-h-"],
  "max-height": ["max-h-"],
  display: [
    "block",
    "inline-block",
    "inline",
    "flex",
    "inline-flex",
    "grid",
    "inline-grid",
    "hidden",
    "contents",
    "flow-root",
    "table",
    "inline-table",
    "table-row",
    "table-cell",
  ],
  position: ["static", "fixed", "absolute", "relative", "sticky"],
  "flex-direction": ["flex-row", "flex-row-reverse", "flex-col", "flex-col-reverse"],
  "align-items": ["items-start", "items-end", "items-center", "items-baseline", "items-stretch"],
  "justify-content": [
    "justify-normal",
    "justify-start",
    "justify-end",
    "justify-center",
    "justify-between",
    "justify-around",
    "justify-evenly",
    "justify-stretch",
  ],
  "gap-x": ["gap-x-"],
  "gap-y": ["gap-y-"],
  gap: ["gap-"],
  padding: ["p-"],
  "padding-x": ["px-"],
  "padding-y": ["py-"],
  "padding-top": ["pt-"],
  "padding-right": ["pr-"],
  "padding-bottom": ["pb-"],
  "padding-left": ["pl-"],
  margin: ["m-"],
  "margin-x": ["mx-"],
  "margin-y": ["my-"],
  "margin-top": ["mt-"],
  "margin-right": ["mr-"],
  "margin-bottom": ["mb-"],
  "margin-left": ["ml-"],
  overflow: ["overflow-auto", "overflow-hidden", "overflow-clip", "overflow-visible", "overflow-scroll"],
  "overflow-x": ["overflow-x-"],
  "overflow-y": ["overflow-y-"],
  "text-size": ["text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-3xl", "text-4xl", "text-5xl", "text-6xl", "text-7xl", "text-8xl", "text-9xl"],
  "text-align": ["text-left", "text-center", "text-right", "text-justify", "text-start", "text-end"],
  "text-color": ["text-"],
  "background-color": ["bg-"],
  "border-x-width": ["border-x", "border-x-"],
  "border-y-width": ["border-y", "border-y-"],
  "border-top-width": ["border-t", "border-t-"],
  "border-right-width": ["border-r", "border-r-"],
  "border-bottom-width": ["border-b", "border-b-"],
  "border-left-width": ["border-l", "border-l-"],
  "border-width": ["border", "border-"],
  "rounded-top-left": ["rounded-tl", "rounded-tl-"],
  "rounded-top-right": ["rounded-tr", "rounded-tr-"],
  "rounded-bottom-right": ["rounded-br", "rounded-br-"],
  "rounded-bottom-left": ["rounded-bl", "rounded-bl-"],
  "rounded-top": ["rounded-t", "rounded-t-"],
  "rounded-right": ["rounded-r", "rounded-r-"],
  "rounded-bottom": ["rounded-b", "rounded-b-"],
  "rounded-left": ["rounded-l", "rounded-l-"],
  rounded: ["rounded", "rounded-"],
  opacity: ["opacity-"],
  z: ["z-"],
  "object-fit": ["object-contain", "object-cover", "object-fill", "object-none", "object-scale-down"],
  "inset-x": ["inset-x-"],
  "inset-y": ["inset-y-"],
  inset: ["inset-"],
  top: ["top-"],
  right: ["right-"],
  bottom: ["bottom-"],
  left: ["left-"],
};

const DEFAULT_CONFIG: QualityConfig = {
  fileLengthThresholds: {
    info: 500,
    warn: 1000,
    urgent: 2000,
  },
  classNameConflicts: {
    enabled: true,
    groups: DEFAULT_CLASS_GROUPS,
  },
  maxExtractProps: 12,
  defaultWrite: "auto",
  defaultOutput: "auto",
  diffMode: "stats",
  inlineDiffMaxBytes: 8_000,
  inlineDiffMaxHunks: 10,
  diffArtifactDir: ".tedit-cache/diffs",
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
  const classNameConflicts = normalizeClassNameConflicts(data);
  const maxExtractProps = normalizePositiveInteger(data.max_extract_props ?? data.maxExtractProps, DEFAULT_CONFIG.maxExtractProps);
  const defaultWrite = normalizeDefaultWrite(data.defaultWrite ?? data.default_write, DEFAULT_CONFIG.defaultWrite);
  const defaultOutput = normalizeDefaultOutput(outputDefaultValue(data), DEFAULT_CONFIG.defaultOutput);
  const diffMode = normalizeDiffMode(diffConfigValue(data, "diffMode", "diff_mode", "diff-mode"), DEFAULT_CONFIG.diffMode);
  const inlineDiffMaxBytes = normalizePositiveInteger(diffConfigValue(data, "inlineDiffMaxBytes", "inline_diff_max_bytes", "inline-diff-max-bytes"), DEFAULT_CONFIG.inlineDiffMaxBytes);
  const inlineDiffMaxHunks = normalizePositiveInteger(diffConfigValue(data, "inlineDiffMaxHunks", "inline_diff_max_hunks", "inline-diff-max-hunks"), DEFAULT_CONFIG.inlineDiffMaxHunks);
  const diffArtifactDir = normalizeNonEmptyString(diffConfigValue(data, "diffArtifactDir", "diff_artifact_dir", "diff-artifact-dir"), DEFAULT_CONFIG.diffArtifactDir, "output.diffArtifactDir");
  const diffArtifacts = normalizeOptionalBoolean(diffConfigValue(data, "diffArtifacts", "diff_artifacts", "diff-artifacts"), undefined, "output.diffArtifacts");
  return {
    fileLengthThresholds: thresholds,
    classNameConflicts,
    maxExtractProps,
    defaultWrite,
    defaultOutput,
    diffMode,
    inlineDiffMaxBytes,
    inlineDiffMaxHunks,
    diffArtifactDir,
    ...(diffArtifacts === undefined ? {} : { diffArtifacts }),
  };
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
  return formatQualityWarnings(warnings);
}

export function qualityWarnings(filePath: string, previous: string, next: string): QualityWarning[] {
  return [
    ...fileLengthWarnings(filePath, previous, next),
    ...classNameConflictWarnings(filePath, next),
  ];
}

export function classNameConflictWarnings(filePath: string, source: string): ClassNameConflictWarning[] {
  if (!supportsClassNameLint(filePath)) return [];

  const config = loadQualityConfig(filePath).classNameConflicts;
  if (!config.enabled) return [];

  let ast: t.File;
  try {
    ast = recast.parse(source, { parser: babelTsParser }) as unknown as t.File;
  } catch {
    return [];
  }

  const warnings: ClassNameConflictWarning[] = [];
  traverseAst(ast, {
    JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
      const element = jsxElementName(path.node.name);
      for (const attribute of path.node.attributes) {
        if (!t.isJSXAttribute(attribute) || !t.isJSXIdentifier(attribute.name)) continue;
        if (attribute.name.name !== "className" && attribute.name.name !== "class") continue;
        const classes = extractClassTokens(attribute.value);
        warnings.push(...conflictsForClassTokens(filePath, element, attribute.name.name, classes, attribute, config));
      }
    },
  });

  return warnings;
}

export function formatQualityWarnings(warnings: QualityWarning[]): string {
  if (warnings.length === 0) return "";
  return warnings.map((warning) => {
    return `tedit: ${warning.message}\n  Suggested next step: ${warning.next_step_hint}`;
  }).join("\n");
}

function supportsClassNameLint(filePath: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(filePath);
}

function extractClassTokens(value: t.JSXAttribute["value"]): ClassToken[] {
  if (!value) return [];
  if (t.isStringLiteral(value)) return classTokensFromText(value.value);
  if (t.isJSXExpressionContainer(value)) return extractClassTokensFromExpression(value.expression);
  return [];
}

function extractClassTokensFromExpression(expression: t.Expression | t.JSXEmptyExpression): ClassToken[] {
  if (t.isJSXEmptyExpression(expression)) return [];
  if (t.isStringLiteral(expression)) return classTokensFromText(expression.value);
  if (t.isTemplateLiteral(expression) && expression.expressions.length === 0) {
    return classTokensFromText(expression.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(""));
  }
  if (t.isLogicalExpression(expression)) {
    return [
      ...extractExpressionLikeTokens(expression.left),
      ...extractExpressionLikeTokens(expression.right),
    ];
  }
  if (t.isConditionalExpression(expression)) {
    const exclusiveGroup = `${expression.start ?? ""}:${expression.end ?? ""}`;
    return [
      ...markExclusiveBranch(extractExpressionLikeTokens(expression.consequent), exclusiveGroup, "consequent"),
      ...markExclusiveBranch(extractExpressionLikeTokens(expression.alternate), exclusiveGroup, "alternate"),
    ];
  }
  if (t.isArrayExpression(expression)) {
    return expression.elements.flatMap((element) => element ? extractExpressionLikeTokens(element) : []);
  }
  if (t.isObjectExpression(expression)) {
    return expression.properties.flatMap((property) => {
      if (!t.isObjectProperty(property) || property.computed) return [];
      if (t.isStringLiteral(property.key)) return classTokensFromText(property.key.value);
      if (t.isIdentifier(property.key)) return classTokensFromText(property.key.name);
      return [];
    });
  }
  if (t.isCallExpression(expression) && isClassNameHelperCall(expression.callee)) {
    return expression.arguments.flatMap((argument) => extractExpressionLikeTokens(argument));
  }
  return [];
}

function extractExpressionLikeTokens(node: t.Node): ClassToken[] {
  if (t.isSpreadElement(node)) return extractExpressionLikeTokens(node.argument);
  if (t.isExpression(node) || t.isJSXEmptyExpression(node)) return extractClassTokensFromExpression(node);
  return [];
}

function isClassNameHelperCall(callee: t.CallExpression["callee"]): boolean {
  if (t.isIdentifier(callee)) return ["cn", "clsx", "classNames", "classnames", "twMerge"].includes(callee.name);
  if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
    return ["cn", "clsx", "classNames", "classnames", "twMerge"].includes(callee.property.name);
  }
  return false;
}

function splitClassTokens(value: string): string[] {
  return value.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

function classTokensFromText(value: string): ClassToken[] {
  return splitClassTokens(value).map((token) => ({ value: token }));
}

function markExclusiveBranch(tokens: ClassToken[], exclusiveGroup: string, branch: "consequent" | "alternate"): ClassToken[] {
  return tokens.map((token) => token.exclusiveGroup
    ? token
    : { ...token, exclusiveGroup, branch });
}

function conflictsForClassTokens(
  filePath: string,
  element: string,
  attribute: "className" | "class",
  classes: ClassToken[],
  node: t.JSXAttribute,
  config: ClassNameConflictConfig,
): ClassNameConflictWarning[] {
  const byGroup = new Map<string, { family: string; variant: string; classes: ClassTokenEffect[] }>();
  for (const className of classes) {
    const parsed = parseTailwindToken(className.value);
    if (!parsed || parsed.important) continue;
    const effect = classEffectForUtility(parsed.utility, config.groups);
    if (!effect) continue;

    const key = `${parsed.variant}\u0000${effect.family}`;
    const entry = byGroup.get(key) ?? { family: effect.family, variant: parsed.variant, classes: [] };
    const classEffect = { ...className, effect };
    if (!entry.classes.some((item) => item.value === classEffect.value && item.exclusiveGroup === classEffect.exclusiveGroup && item.branch === classEffect.branch)) {
      entry.classes.push(classEffect);
    }
    byGroup.set(key, entry);
  }

  const location = node.loc?.start;
  return [...byGroup.values()]
    .map((entry) => ({ entry, classes: conflictingClassValues(entry.classes) }))
    .filter(({ classes: conflictClasses }) => conflictClasses.length > 1)
    .map(({ entry, classes: conflictClasses }) => ({
      code: "CLASSNAME_CONFLICT",
      level: "warn",
      file: filePath,
      element,
      attribute,
      group: entry.family,
      classes: conflictClasses,
      ...(location ? { line: location.line, column: location.column + 1 } : {}),
      ...(entry.variant ? { variant: entry.variant } : {}),
      message: `${locationPrefix(filePath, location)}<${element}> ${entry.family} class conflict: ${conflictClasses.map((item) => JSON.stringify(item)).join(" + ")}.`,
      next_step_hint: `Remove the older ${entry.family} utility, or add ! to the intended override if the conflict is deliberate.`,
    }));
}

function conflictingClassValues(classes: ClassTokenEffect[]): string[] {
  const conflicts = new Set<string>();
  for (let index = 0; index < classes.length; index++) {
    for (let otherIndex = index + 1; otherIndex < classes.length; otherIndex++) {
      if (classes[index].value === classes[otherIndex].value) continue;
      if (!canClassTokensCoexist(classes[index], classes[otherIndex])) continue;
      if (!classEffectsOverlap(classes[index].effect, classes[otherIndex].effect)) continue;
      conflicts.add(classes[index].value);
      conflicts.add(classes[otherIndex].value);
    }
  }
  return [...conflicts];
}

function canClassTokensCoexist(left: ClassToken, right: ClassToken): boolean {
  if (!left.exclusiveGroup || !right.exclusiveGroup) return true;
  return left.exclusiveGroup !== right.exclusiveGroup || left.branch === right.branch;
}

function classEffectsOverlap(left: ClassEffect, right: ClassEffect): boolean {
  if (left.family !== right.family) return false;
  if (left.axes.includes("all") || right.axes.includes("all")) return true;
  return left.axes.some((axis) => right.axes.includes(axis));
}

function parseTailwindToken(token: string): { variant: string; utility: string; important: boolean } | null {
  const parts = splitVariantParts(token);
  const utilityRaw = parts.pop();
  if (!utilityRaw) return null;
  const important = utilityRaw.startsWith("!") || token.startsWith("!");
  const utility = utilityRaw.replace(/^!/, "").replace(/^-/, "");
  return {
    variant: parts.join(":"),
    utility,
    important,
  };
}

function splitVariantParts(token: string): string[] {
  const parts: string[] = [];
  let current = "";
  let bracketDepth = 0;
  for (const char of token) {
    if (char === "[") bracketDepth++;
    else if (char === "]" && bracketDepth > 0) bracketDepth--;

    if (char === ":" && bracketDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function classEffectForUtility(utility: string, groups: Record<string, string[]>): ClassEffect | null {
  const group = classGroupForUtility(utility, groups);
  if (!group) return null;
  return classEffectForGroup(group, utility);
}

function classGroupForUtility(utility: string, groups: Record<string, string[]>): string | null {
  for (const [group, patterns] of Object.entries(groups)) {
    if (matchesClassGroup(utility, group, patterns)) return group;
  }
  return null;
}

function matchesClassGroup(utility: string, group: string, patterns: string[]): boolean {
  if (group === "text-size") return isTextSizeUtility(utility);
  if (group === "text-color") return isTextColorUtility(utility);
  if (group === "background-color") return isBackgroundColorUtility(utility);
  if (group.startsWith("border-") || group === "border-width") return isBorderWidthUtilityForGroup(utility, group);
  if (group.startsWith("rounded")) return isRoundedUtilityForGroup(utility, group);
  return patterns.some((pattern) => matchesClassPattern(utility, pattern));
}

function matchesClassPattern(utility: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return utility.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("-") || pattern.endsWith("[")) return utility.startsWith(pattern);
  return utility === pattern;
}

function classEffectForGroup(group: string, utility: string): ClassEffect {
  const axis = axisForClassGroup(group);
  if (axis) return axis;
  if (group === "text-size") return { group, family: "text-size", axes: AXIS_ALL };
  if (group === "text-color") return { group, family: "text-color", axes: AXIS_ALL };
  if (group === "border-width") return { group, family: "border-width", axes: BOX_AXES };
  if (group.startsWith("border-") && group.endsWith("-width")) return { group, family: "border-width", axes: borderAxesForGroup(group) };
  if (group === "rounded") return { group, family: "border-radius", axes: CORNER_AXES };
  if (group.startsWith("rounded-")) return { group, family: "border-radius", axes: roundedAxesForGroup(group) };
  return { group, family: group, axes: AXIS_ALL };
}

function axisForClassGroup(group: string): ClassEffect | null {
  switch (group) {
    case "padding":
      return { group, family: "padding", axes: BOX_AXES };
    case "padding-x":
      return { group, family: "padding", axes: AXIS_X };
    case "padding-y":
      return { group, family: "padding", axes: AXIS_Y };
    case "padding-top":
      return { group, family: "padding", axes: ["top"] };
    case "padding-right":
      return { group, family: "padding", axes: ["right"] };
    case "padding-bottom":
      return { group, family: "padding", axes: ["bottom"] };
    case "padding-left":
      return { group, family: "padding", axes: ["left"] };
    case "margin":
      return { group, family: "margin", axes: BOX_AXES };
    case "margin-x":
      return { group, family: "margin", axes: AXIS_X };
    case "margin-y":
      return { group, family: "margin", axes: AXIS_Y };
    case "margin-top":
      return { group, family: "margin", axes: ["top"] };
    case "margin-right":
      return { group, family: "margin", axes: ["right"] };
    case "margin-bottom":
      return { group, family: "margin", axes: ["bottom"] };
    case "margin-left":
      return { group, family: "margin", axes: ["left"] };
    case "gap":
      return { group, family: "gap", axes: ["row", "column"] };
    case "gap-x":
      return { group, family: "gap", axes: ["column"] };
    case "gap-y":
      return { group, family: "gap", axes: ["row"] };
    case "inset":
      return { group, family: "inset", axes: BOX_AXES };
    case "inset-x":
      return { group, family: "inset", axes: AXIS_X };
    case "inset-y":
      return { group, family: "inset", axes: AXIS_Y };
    case "top":
      return { group, family: "inset", axes: ["top"] };
    case "right":
      return { group, family: "inset", axes: ["right"] };
    case "bottom":
      return { group, family: "inset", axes: ["bottom"] };
    case "left":
      return { group, family: "inset", axes: ["left"] };
    default:
      return null;
  }
}

function borderAxesForGroup(group: string): string[] {
  switch (group) {
    case "border-x-width":
      return AXIS_X;
    case "border-y-width":
      return AXIS_Y;
    case "border-top-width":
      return ["top"];
    case "border-right-width":
      return ["right"];
    case "border-bottom-width":
      return ["bottom"];
    case "border-left-width":
      return ["left"];
    default:
      return BOX_AXES;
  }
}

function roundedAxesForGroup(group: string): string[] {
  switch (group) {
    case "rounded-top":
      return ["top-left", "top-right"];
    case "rounded-right":
      return ["top-right", "bottom-right"];
    case "rounded-bottom":
      return ["bottom-right", "bottom-left"];
    case "rounded-left":
      return ["top-left", "bottom-left"];
    case "rounded-top-left":
      return ["top-left"];
    case "rounded-top-right":
      return ["top-right"];
    case "rounded-bottom-right":
      return ["bottom-right"];
    case "rounded-bottom-left":
      return ["bottom-left"];
    default:
      return CORNER_AXES;
  }
}

function isTextSizeUtility(utility: string): boolean {
  const base = stripSlashSuffix(utility);
  if (TEXT_SIZE_CLASSES.has(base)) return true;
  const arbitrary = arbitraryBracketValue(base, "text");
  if (arbitrary === null) return false;
  if (arbitrary.startsWith("length:")) return true;
  if (arbitrary.startsWith("color:")) return false;
  return isCssLengthValue(arbitrary);
}

function isTextColorUtility(utility: string): boolean {
  if (!utility.startsWith("text-")) return false;
  const base = stripSlashSuffix(utility);
  return !isTextSizeUtility(utility) && !TEXT_NON_COLOR_CLASSES.has(base) && !base.startsWith("text-opacity-");
}

function isBackgroundColorUtility(utility: string): boolean {
  if (!utility.startsWith("bg-")) return false;
  if (["bg-fixed", "bg-local", "bg-scroll", "bg-cover", "bg-contain", "bg-auto", "bg-center", "bg-top", "bg-right", "bg-bottom", "bg-left", "bg-none"].includes(utility)) {
    return false;
  }
  return !["bg-opacity-", "bg-blend-", "bg-clip-", "bg-origin-", "bg-gradient-", "bg-size-"].some((prefix) => utility.startsWith(prefix));
}

function isBorderWidthUtilityForGroup(utility: string, group: string): boolean {
  if (group === "border-width") return utility === "border" || isPrefixedBorderWidth(utility, "border");
  if (group === "border-x-width") return utility === "border-x" || isPrefixedBorderWidth(utility, "border-x");
  if (group === "border-y-width") return utility === "border-y" || isPrefixedBorderWidth(utility, "border-y");
  if (group === "border-top-width") return utility === "border-t" || isPrefixedBorderWidth(utility, "border-t");
  if (group === "border-right-width") return utility === "border-r" || isPrefixedBorderWidth(utility, "border-r");
  if (group === "border-bottom-width") return utility === "border-b" || isPrefixedBorderWidth(utility, "border-b");
  if (group === "border-left-width") return utility === "border-l" || isPrefixedBorderWidth(utility, "border-l");
  return false;
}

function isPrefixedBorderWidth(utility: string, prefix: string): boolean {
  if (!utility.startsWith(`${prefix}-`)) return false;
  const value = utility.slice(prefix.length + 1);
  return BORDER_WIDTH_VALUES.has(value) || isArbitraryLengthToken(value);
}

function isRoundedUtilityForGroup(utility: string, group: string): boolean {
  const prefix = roundedPrefixForGroup(group);
  if (!prefix) return false;
  if (utility === prefix) return true;
  if (!utility.startsWith(`${prefix}-`)) return false;
  const value = utility.slice(prefix.length + 1);
  return ROUNDED_VALUES.has(value) || isArbitraryLengthToken(value);
}

function roundedPrefixForGroup(group: string): string | null {
  switch (group) {
    case "rounded":
      return "rounded";
    case "rounded-top":
      return "rounded-t";
    case "rounded-right":
      return "rounded-r";
    case "rounded-bottom":
      return "rounded-b";
    case "rounded-left":
      return "rounded-l";
    case "rounded-top-left":
      return "rounded-tl";
    case "rounded-top-right":
      return "rounded-tr";
    case "rounded-bottom-right":
      return "rounded-br";
    case "rounded-bottom-left":
      return "rounded-bl";
    default:
      return null;
  }
}

function stripSlashSuffix(utility: string): string {
  let bracketDepth = 0;
  for (let index = 0; index < utility.length; index++) {
    const char = utility[index];
    if (char === "[") bracketDepth++;
    else if (char === "]" && bracketDepth > 0) bracketDepth--;
    else if (char === "/" && bracketDepth === 0) return utility.slice(0, index);
  }
  return utility;
}

function arbitraryBracketValue(utility: string, prefix: string): string | null {
  const start = `${prefix}-[`;
  if (!utility.startsWith(start) || !utility.endsWith("]")) return null;
  return utility.slice(start.length, -1);
}

function isArbitraryLengthToken(value: string): boolean {
  if (!value.startsWith("[") || !value.endsWith("]")) return false;
  return isCssLengthValue(value.slice(1, -1));
}

function isCssLengthValue(value: string): boolean {
  const normalized = value.trim();
  if (/^-?\d*\.?\d+$/.test(normalized)) return true;
  if (/^-?\d*\.?\d+(px|r?em|%|vh|dvh|svh|lvh|vw|dvw|svw|lvw|vmin|vmax|ch|ex|cap|ic|lh|rlh|cm|mm|in|pt|pc|q)$/.test(normalized)) return true;
  if (/^calc\(.+\)$/.test(normalized)) return true;
  if (/^clamp\(.+\)$/.test(normalized)) return true;
  if (/^min\(.+\)$/.test(normalized)) return true;
  return /^max\(.+\)$/.test(normalized);
}

function jsxElementName(name: t.JSXOpeningElement["name"]): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) return `${jsxElementName(name.object)}.${jsxElementName(name.property)}`;
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`;
  return "unknown";
}

function locationPrefix(filePath: string, location: t.SourceLocation["start"] | undefined): string {
  return location ? `${filePath}:${location.line}:${location.column + 1} ` : `${filePath} `;
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

function normalizeClassNameConflicts(data: Record<string, unknown>): ClassNameConflictConfig {
  const raw = data.classNameConflicts ?? data.class_name_conflicts;
  const rawGroups = data.classNameConflictGroups ?? data.class_name_conflict_groups;
  let enabled = DEFAULT_CONFIG.classNameConflicts.enabled;
  let groups = { ...DEFAULT_CLASS_GROUPS };

  if (raw === false) enabled = false;
  else if (raw === true || raw === undefined) {
    // Keep defaults.
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>;
    enabled = normalizeOptionalBoolean(input.enabled, enabled, "classNameConflicts.enabled");
    groups = normalizeClassGroupMap(input.groups ?? input.class_groups, groups);
  } else {
    fail("INVALID_TEDIT_CONFIG", "classNameConflicts must be a boolean or an object.");
  }

  groups = normalizeClassGroupMap(rawGroups, groups);
  return { enabled, groups };
}

function normalizeClassGroupMap(value: unknown, base: Record<string, string[]>): Record<string, string[]> {
  if (value === undefined) return base;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TEDIT_CONFIG", "classNameConflicts.groups must be an object of string arrays.");
  }
  const groups = { ...base };
  for (const [group, patterns] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(patterns) || patterns.some((item) => typeof item !== "string" || item.length === 0)) {
      fail("INVALID_TEDIT_CONFIG", `classNameConflicts.groups.${group} must be a non-empty string array.`);
    }
    groups[group] = patterns as string[];
  }
  return groups;
}

function normalizeOptionalBoolean<T extends boolean | undefined>(value: unknown, fallback: T, label: string): boolean | T {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail("INVALID_TEDIT_CONFIG", `${label} must be true or false.`);
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

function normalizeDiffMode(value: unknown, fallback: QualityConfig["diffMode"]): QualityConfig["diffMode"] {
  if (value === undefined) return fallback;
  if (value === "off" || value === "stats" || value === "auto" || value === "full") return value;
  fail("INVALID_TEDIT_CONFIG", "output.diffMode must be off, stats, auto, or full.");
}

function normalizeNonEmptyString(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim().length > 0) return value;
  fail("INVALID_TEDIT_CONFIG", `${label} must be a non-empty string.`);
}

function diffConfigValue(data: Record<string, unknown>, ...keys: string[]): unknown {
  const output = data.output && typeof data.output === "object" && !Array.isArray(data.output)
    ? data.output as Record<string, unknown>
    : {};
  for (const key of keys) {
    if (output[key] !== undefined) return output[key];
    if (data[key] !== undefined) return data[key];
  }
  return undefined;
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
