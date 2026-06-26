#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  BASE_ACTIONS,
  parseLineRange,
  parseVerificationFields,
  planBaseEdit,
  verifyParseForFile,
  type BaseEditMutation,
  type BaseFindStrategy,
  type ParseVerificationFields,
} from "./base-edit.js";
import { chainToFlow, fileChainToWorkspaceFlow, parseChainSegments, parseChainText, workspaceChainToFlow } from "./chain.js";
import type { ImportEditSpec, TextMatchSpec, TextValueSpec, TreeNodeSpec, ValueSpec } from "./core/document.js";
import { getOptionalAdapterForFile, listRules, openDocumentForFile } from "./core/registry.js";
import { runAstEdit, runAstSelect, runScanStrings } from "./ast-tools.js";
import { inspectRange, searchText } from "./search-tools.js";
import { historyTrace } from "./history-tools.js";
import { runTsEdit, runTsMove, runTsSelect } from "./ts-tools.js";
import { unifiedDiff } from "./diff.js";
import { toErrorResult } from "./errors.js";
import { formatAgentResult, outputOptionsFromConfig, parseDiffMode, parseOutputMode, type OutputMode, type OutputOptions } from "./output.js";
import { planExtract, type HelperPolicy } from "./extract.js";
import { parseMultieditInput, runMultiedit, runMultieditInput, type MultieditResult } from "./multiedit.js";
import { runPatchInput } from "./patch.js";
import { runRefactorState } from "./refactor-state.js";
import { applyRefactorPlan, buildExtractComponentPlan, buildRefactorStatePlan, inspectRefactorPlan, writePlanFile, type InspectPlanResult } from "./refactor-plan.js";
import { analyzeState, formatQualityWarnings, loadQualityConfig, qualityWarnings, type QualityWarning } from "./quality.js";
import { loadParams, parseFlowInput, runFlow } from "./flow.js";
import {
  buildScaffoldSource,
  listTemplates,
  loadScaffoldSpec,
  loadTemplateSpec,
  parseParams,
  parseScaffoldExport,
  parseScaffoldImport,
  type ScaffoldExportSpec,
  type ScaffoldSpec,
} from "./scaffold.js";
import { runWorkspaceFlow, type WorkspaceFlowStep } from "./workspace-flow.js";
import { packageVersion } from "./version.js";
import { cleanBackups, formatWritePolicyNotes, listBackups, maybeWriteBackup, resolveWritePolicy, restoreBackup, writePolicyReport, type BackupResult, type WritePolicy } from "./write-policy.js";

type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
};

type EditSpec = Record<string, unknown>;

type VerifyFileEntry = { file: string } & ParseVerificationFields & { warnings: QualityWarning[] };
type SetupScope = "user" | "project";
type SetupTarget = "codex" | "claude";

let currentArgs: ParsedArgs | undefined;

main().catch((error) => {
  const result = toErrorResult(error);
  if (currentArgs?.command === "edit" && summaryRequested(currentArgs) && !quietRequested(currentArgs) && !currentArgs.flags.json) {
    process.stdout.write(formatEditFailureSummary(result, currentArgs) + "\n");
  } else {
    process.stderr.write(JSON.stringify(formatErrorResult(result), null, 2) + "\n");
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  currentArgs = args;
  if (args.command === "--version" || args.command === "-v" || args.flags.version) {
    printVersion();
    return;
  }
  if (args.command === "help") {
    printHelp(args.positionals[0]);
    return;
  }
  if (!args.command || args.flags.help || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  switch (args.command) {
    case "edit":
      commandEdit(args);
      return;
    case "multiedit":
      commandMultiedit(args);
      return;
    case "verify":
      commandVerify(args);
      return;
    case "verify-file":
      commandVerifyFile(args);
      return;
    case "patch":
      commandPatch(args);
      return;
    case "actions":
      commandActions(args);
      return;
    case "setup":
      await commandSetup(args);
      return;
    case "doctor":
      commandDoctor(args);
      return;
    case "update":
      await commandUpdate(args);
      return;
    case "inspect-range":
    case "inspect_range":
      commandInspectRange(args);
      return;
    case "search-text":
    case "search_text":
      commandSearchText(args);
      return;
    case "history-trace":
    case "history_trace":
      commandHistoryTrace(args);
      return;
    case "scan-strings":
    case "scan_strings":
      commandScanStrings(args);
      return;
    case "ast-select":
    case "ast_select":
      commandAstSelect(args);
      return;
    case "ast-edit":
    case "ast_edit":
      commandAstEdit(args);
      return;
    case "ts-select":
    case "ts_select":
      commandTsSelect(args);
      return;
    case "ts-edit":
    case "ts_edit":
      commandTsEdit(args);
      return;
    case "ts-move":
    case "ts_move":
      commandTsMove(args);
      return;
    case "analyze-state":
      commandAnalyzeState(args);
      return;
    case "refactor-state":
      commandRefactorState(args);
      return;
    case "find":
      commandFind(args);
      return;
    case "inspect":
      commandInspect(args);
      return;
    case "append":
    case "prepend":
      commandInsert(args, args.command);
      return;
    case "wrap":
      commandWrap(args);
      return;
    case "unwrap":
    case "remove":
      commandTargetOnly(args, args.command);
      return;
    case "rename":
      commandRename(args);
      return;
    case "insertComment":
      commandInsertComment(args);
      return;
    case "text":
      commandText(args);
      return;
    case "prop":
      commandProp(args);
      return;
    case "class":
      commandClass(args);
      return;
    case "imports":
      commandImports(args);
      return;
    case "expr":
      commandExpr(args);
      return;
    case "extract":
      commandExtract(args);
      return;
    case "apply-plan":
      commandApplyPlan(args);
      return;
    case "plan":
      commandPlan(args);
      return;
    case "create":
      commandCreate(args);
      return;
    case "write":
      commandWrite(args);
      return;
    case "scaffold":
      commandScaffold(args);
      return;
    case "new":
      commandNew(args);
      return;
    case "templates":
      commandTemplates(args);
      return;
    case "flow":
      commandFlow(args);
      return;
    case "workspace-flow":
    case "wflow":
      commandWorkspaceFlow(args);
      return;
    case "chain":
      commandChain(args);
      return;
    case "chain-workspace":
    case "wchain":
      commandWorkspaceChain(args);
      return;
    case "rules":
      commandRules(args);
      return;
    case "backups":
      commandBackups(args);
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

function commandEdit(args: ParsedArgs): void {
  const spec = loadEditSpec(args);
  const filePath = resolveEditFilePath(args, spec);
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }
  ensureSingleEditStdin(args);

  const source = readFileSync(filePath, "utf8");
  const strategy = parseBaseFindStrategy(args, spec);
  const mutation = parseBaseMutation(args, spec);
  const expectCount = optionalIntegerInput(args, spec, "expect-count", ["expectCount", "expect-count", "expect_count"]);
  const plan = planBaseEdit({
    filePath,
    source,
    strategy,
    mutation,
    replaceAll: booleanInput(args, spec, "replace-all", ["replaceAll", "replace-all", "replace_all"]),
    ...(expectCount === undefined ? {} : { expectCount }),
  });
  const policy = resolveWritePolicy(filePath, writeFlags(args));
  const shouldWrite = policy.write;
  const warnings = qualityWarnings(filePath, source, plan.nextSource);
  let backup: BackupResult = {};

  if (shouldWrite && plan.changed) {
    backup = maybeWriteBackup(filePath, source, policy, plan.changed, plan.nextSource);
    writeFileSync(filePath, plan.nextSource);
  }

  const result = {
    success: true,
    file: filePath,
    action: plan.action,
    strategy: plan.strategy,
    changed: plan.changed,
    written: shouldWrite && plan.changed,
    ...parseVerificationFields(plan.parseVerification),
    matches: plan.matches,
    guardrails: plan.guardrails,
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(plan.diff ? { diff: plan.diff } : {}),
  };

  writeDiffOut(args, result);
  if (quietRequested(args)) return;

  if (summaryRequested(args)) {
    process.stdout.write(formatEditSummary(result) + "\n");
    return;
  }

  output(
    args,
    result,
    withWarnings(
      withWritePolicyNotes(
        shouldWrite
          ? (plan.changed ? "Wrote" : "No changes") + ": " + filePath
          : plan.diff || "No changes",
        policy,
        backup,
      ),
      warnings,
    ),
  );
}

function commandActions(args: ParsedArgs): void {
  const [filePath] = args.positionals;
  const adapter = filePath ? getOptionalAdapterForFile(filePath) : null;
  const languageRules = adapter ? [adapter.rule] : filePath ? [] : listRules();
  const actions = [
    ...BASE_ACTIONS,
    "inspect-range",
    "search-text",
    "history-trace",
    "scan-strings",
    "ast-select",
    "ast-edit",
    "ts-select",
    "ts-edit",
    "ts-move",
    ...languageRules.flatMap((rule) => rule.actions),
  ];
  const result = {
    success: true,
    file: filePath,
    rules: [
      { name: "base", extensions: ["*"], actions: BASE_ACTIONS },
      ...languageRules,
    ],
    actions,
  };

  output(args, result, actions.join("\n"));
}

async function commandSetup(args: ParsedArgs): Promise<void> {
  const target = args.positionals[0] ?? "print";
  if (target === "print") {
    process.stdout.write(JSON.stringify({ mcpServers: { tedit: { command: "tedit-mcp" } } }, null, 2) + "\n");
    return;
  }
  if (target !== "mcp" && target !== "codex" && target !== "claude") throw new Error("setup target must be mcp, codex, claude, or print.");
  const targets = await setupTargets(args, target);
  const scope = await setupScope(args, target);
  const commands = targets.map((setupTarget) => setupCommand(setupTarget, scope));
  if (args.flags["dry-run"]) {
    process.stdout.write(commands.map((command) => command.join(" ")).join("\n") + "\n");
    return;
  }
  for (const command of commands) {
    const setupTarget = command[0] as SetupTarget;
    if (!commandExists(setupTarget)) {
      process.stdout.write(`${setupTarget} CLI not found. Add this MCP config manually:\n`);
      await commandSetup({ ...args, positionals: ["print"] });
      continue;
    }
    const result = spawnCommand(command[0], command.slice(1), { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${setupTarget} MCP setup failed.${result.error ? ` ${result.error.message}` : ""}`);
  }
}

async function setupTargets(args: ParsedArgs, target: "mcp" | SetupTarget): Promise<SetupTarget[]> {
  if (target !== "mcp") return [target];
  const raw = stringFlag(args, "target") ?? stringFlag(args, "host");
  if (raw !== undefined) return parseSetupTargets(raw);
  if (args.flags["dry-run"] || !process.stdin.isTTY) throw new Error("tedit setup mcp requires --target claude|codex|both when not interactive.");
  return promptSetupTargets();
}

function parseSetupTargets(raw: string): SetupTarget[] {
  const target = raw.trim().toLowerCase();
  if (target === "claude" || target === "1") return ["claude"];
  if (target === "codex" || target === "2") return ["codex"];
  if (target === "both" || target === "all" || target === "3") return ["claude", "codex"];
  throw new Error("setup --target must be claude, codex, or both.");
}

function setupCommand(target: SetupTarget, scope: SetupScope): string[] {
  if (target === "codex") {
    if (scope === "project") throw new Error("Codex CLI does not currently support project-scoped MCP setup; use --scope user.");
    return ["codex", "mcp", "add", "tedit", "--", "tedit-mcp"];
  }
  return ["claude", "mcp", "add", "--scope", scope, "tedit", "--", "tedit-mcp"];
}

async function setupScope(args: ParsedArgs, target: "mcp" | SetupTarget): Promise<SetupScope> {
  const raw = stringFlag(args, "scope");
  if (raw !== undefined) return parseSetupScope(raw);
  if (args.flags["dry-run"] || !process.stdin.isTTY) return "user";
  return promptSetupScope(target);
}

function parseSetupScope(raw: string): SetupScope {
  const scope = raw.trim().toLowerCase();
  if (scope === "user" || scope === "project") return scope;
  throw new Error("setup --scope must be user or project.");
}

function commandDoctor(args: ParsedArgs): void {
  const latest = args.flags["skip-update"] ? undefined : latestNpmVersion(false);
  const checks = [
    { name: "tedit", ok: true, detail: packageVersion() },
    { name: "tedit-mcp", ok: commandExists("tedit-mcp"), detail: commandPath("tedit-mcp") ?? "not found" },
    { name: "actions", ok: true, detail: String(BASE_ACTIONS.length + listRules().flatMap((rule) => rule.actions).length) + " actions" },
  ];
  const ok = checks.every((check) => check.ok);
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ ok, version: packageVersion(), latest, checks }, null, 2) + "\n");
  } else {
    process.stdout.write(checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`).join("\n") + "\n");
    if (latest && latest !== packageVersion()) process.stdout.write(`ℹ update available: ${packageVersion()} -> ${latest}\n  run: tedit update\n`);
  }
  if (!ok) process.exitCode = 1;
}

async function commandUpdate(args: ParsedArgs): Promise<void> {
  const latest = latestNpmVersion(true);
  const current = packageVersion();
  if (latest === current) {
    process.stdout.write(`tedit is up to date (${current}).\n`);
    return;
  }
  process.stdout.write(`update available: ${current} -> ${latest}\n`);
  process.stdout.write("run: npm install -g tedit-tools@latest\n");
  if (args.flags.check) return;
  const yes = Boolean(args.flags.yes || args.flags.y);
  if (!yes && !(await confirm("Run update now? [y/N] "))) return;
  const result = spawnCommand("npm", ["install", "-g", "tedit-tools@latest"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("npm install -g tedit-tools@latest failed.");
}

function commandInspectRange(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "inspect-range <file> (--lines N:M | --head N | --tail N) [--context N] [--json]");
  const result = inspectRange(filePath, {
    ...(stringFlag(args, "lines") === undefined ? {} : { lines: stringFlag(args, "lines") }),
    ...(positiveIntegerFlag(args, "head") === undefined ? {} : { head: positiveIntegerFlag(args, "head") }),
    ...(positiveIntegerFlag(args, "tail") === undefined ? {} : { tail: positiveIntegerFlag(args, "tail") }),
    context: nonnegativeIntegerFlag(args, "context") ?? 0,
  });
  output(args, result, formatInspectedLines(result.lines as unknown[]));
}

function commandSearchText(args: ParsedArgs): void {
  const query = stringFlag(args, "query") ?? args.positionals[0];
  if (!query) throw new Error("Usage: tedit search-text <query> [path...] [--regex] [--glob <glob>] [--json]");
  const paths = stringFlags(args, "path");
  const positionalPaths = args.positionals.slice(args.positionals[0] === query ? 1 : 0);
  const result = searchText({
    query,
    paths: paths.length > 0 ? paths : positionalPaths,
    regex: booleanFlag(args, "regex"),
    glob: stringFlag(args, "glob"),
    maxResults: positiveIntegerFlag(args, "max-results") ?? positiveIntegerFlag(args, "maxResults"),
    context: nonnegativeIntegerFlag(args, "context"),
    multieditSpec: booleanFlag(args, "multiedit-spec") || booleanFlag(args, "multieditSpec"),
    replace: stringFlag(args, "replace"),
    caseSensitive: booleanFlag(args, "case-sensitive") || booleanFlag(args, "caseSensitive"),
    includeHidden: booleanFlag(args, "include-hidden") || booleanFlag(args, "includeHidden"),
  });
  output(args, result, formatSearchResults(result.results as unknown[]));
}

function commandHistoryTrace(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "history-trace <file> [--lines N:M|--contains text|--regex pattern] [--limit N] [--json]");
  const result = historyTrace(filePath, {
    lines: stringFlag(args, "lines"),
    contains: stringFlag(args, "contains"),
    regex: stringFlag(args, "regex"),
    limit: positiveIntegerFlag(args, "limit"),
  });
  output(args, result, formatHistoryTrace(result));
}

function commandScanStrings(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "scan-strings <file> [--contains <text>] [--include-excluded] [--json]");
  const result = runScanStrings(filePath, {
    contains: stringFlag(args, "contains"),
    includeExcluded: booleanFlag(args, "include-excluded") || booleanFlag(args, "includeExcluded"),
    minLength: positiveIntegerFlag(args, "min-length") ?? positiveIntegerFlag(args, "minLength"),
  });
  output(args, result, formatAstStrings(result.strings as unknown[]));
}

function commandAstSelect(args: ParsedArgs): void {
  const [filePath, selector] = requirePositionals(args, 2, "ast-select <file> <selector> [--json]");
  const result = runAstSelect(filePath, selector);
  output(args, result, formatAstMatches(result.matches as unknown[]));
}

function commandAstEdit(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "ast-edit <file> [selector] --replace <text> [--string text|--contains text|--jsx-text text|--jsx-attr name|--object-key key|--call callee] [--dry-run|--write]");
  const selector = resolveAstEditSelector(args);
  const result = runAstEdit(filePath, {
    selector,
    replace: requiredStringFlag(args, "replace", "ast-edit requires --replace <text>."),
    ...writeFlags(args),
  });
  writeDiffOut(args, result);
  if (quietRequested(args)) return;
  output(args, result, typeof result.diff === "string" && result.diff.length > 0 ? result.diff : "No changes");
}

function commandTsSelect(args: ParsedArgs): void {
  const [filePath, selector] = requirePositionals(args, 1, "ts-select <file> [fn:name|class:Name|method:Owner.name|prop:name|var:name] [--json]");
  const result = runTsSelect(filePath, selector);
  output(args, result, formatAstMatches(result.matches as unknown[]));
}

function commandTsEdit(args: ParsedArgs): void {
  const [filePath, selector] = requirePositionals(args, 2, "ts-edit <file> <selector> --body <body>|--insert-before <code>|--insert-after <code> [--dry-run|--write]");
  const result = runTsEdit(filePath, {
    selector,
    action: tsEditActionFlag(args),
    body: readOptionalTsTextInput(args, "body"),
    insertBefore: readOptionalTsTextInput(args, "insert-before"),
    insertAfter: readOptionalTsTextInput(args, "insert-after"),
    ...writeFlags(args),
  });
  writeDiffOut(args, result);
  if (quietRequested(args)) return;
  output(args, result, typeof result.diff === "string" && result.diff.length > 0 ? result.diff : "No changes");
}

function commandTsMove(args: ParsedArgs): void {
  const [filePath, target] = requirePositionals(args, 2, "ts-move <file> <target-selector> (--before <selector>|--after <selector>) [--confirm-trivia] [--dry-run|--write]");
  const result = runTsMove(filePath, {
    target,
    before: stringFlag(args, "before"),
    after: stringFlag(args, "after"),
    take: csvFlags(args, "take"),
    drop: csvFlags(args, "drop"),
    confirmTrivia: booleanFlag(args, "confirm-trivia") || booleanFlag(args, "confirmTrivia"),
    sourceHash: stringFlag(args, "source-hash") ?? stringFlag(args, "sourceHash"),
    includeTriviaContent: booleanFlag(args, "include-trivia-content") || booleanFlag(args, "includeTriviaContent"),
    ...writeFlags(args),
  });
  writeDiffOut(args, result);
  if (quietRequested(args)) return;
  output(args, result, typeof result.diff === "string" && result.diff.length > 0 ? result.diff : "No changes");
}

function resolveAstEditSelector(args: ParsedArgs): string {
  const positional = args.positionals[1];
  const stringValue = stringFlag(args, "string");
  const contains = stringFlag(args, "contains");
  const jsxText = stringFlag(args, "jsx-text") ?? stringFlag(args, "jsxText");
  const jsxAttr = stringFlag(args, "jsx-attr") ?? stringFlag(args, "jsxAttr");
  const objectKey = stringFlag(args, "object-key") ?? stringFlag(args, "objectKey");
  const call = stringFlag(args, "call");
  const shortcutCount = [stringValue, contains, jsxText, jsxAttr, objectKey, call].filter((value) => value !== undefined).length;
  if (positional && shortcutCount > 0) throw new Error("ast-edit accepts either a selector or one shortcut flag.");
  if (shortcutCount > 1) throw new Error("ast-edit accepts only one shortcut flag.");
  if (positional) return positional;
  if (stringValue !== undefined) return `StringLiteral[value=${astSelectorValue(stringValue)}]`;
  if (contains !== undefined) return `StringLiteral[value*=${astSelectorValue(contains)}]`;
  if (jsxText !== undefined) return `JSXText[value*=${astSelectorValue(jsxText)}]`;
  if (jsxAttr !== undefined) return `JSXAttribute[name=${astSelectorValue(jsxAttr)}]`;
  if (objectKey !== undefined) return `ObjectProperty[key.name=${astSelectorValue(objectKey)}]`;
  if (call !== undefined) return `${astCallSelector(call)} > StringLiteral`;
  throw new Error("ast-edit requires a selector or one of --string, --contains, --jsx-text, --jsx-attr, --object-key, or --call.");
}

function astSelectorValue(value: string): string {
  if (!value.includes("\"")) return JSON.stringify(value);
  if (!value.includes("'")) return `'${value}'`;
  throw new Error("AST shortcut values cannot contain both single and double quotes yet; pass an explicit selector.");
}

function astCallSelector(value: string): string {
  const parts = value.split(".");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `CallExpression[callee.object.name=${astSelectorValue(parts[0])}][callee.property.name=${astSelectorValue(parts[1])}]`;
  }
  return `CallExpression[callee.name=${astSelectorValue(value)}]`;
}

function tsEditActionFlag(args: ParsedArgs): "replace-body" | "insert-before" | "insert-after" | undefined {
  const raw = stringFlag(args, "action");
  if (raw === undefined) return undefined;
  if (raw === "replace-body" || raw === "insert-before" || raw === "insert-after") return raw;
  throw new Error("ts-edit --action must be replace-body, insert-before, or insert-after.");
}

function readOptionalTsTextInput(args: ParsedArgs, name: "body" | "insert-before" | "insert-after"): string | undefined {
  const inline = flagValuePresent(args, name) ? stringFlag(args, name) ?? "" : undefined;
  const file = stringFlag(args, `${name}-file`);
  const stdin = booleanFlag(args, `${name}-stdin`);
  const count = [inline !== undefined, file !== undefined, stdin].filter(Boolean).length;
  if (count > 1) throw new Error(`ts-edit accepts only one input source for --${name}.`);
  if (inline !== undefined) return inline;
  if (file !== undefined) return readFileSync(file, "utf8");
  if (stdin) return readFileSync(0, "utf8");
  return undefined;
}

function csvFlags(args: ParsedArgs, name: string): string[] {
  return stringFlags(args, name).flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
}

function commandAnalyzeState(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "analyze-state <file>");
  const result = analyzeState(filePath);
  const text = [
    `${filePath}: ${result.states_total} state(s), ${result.handlers_total} handler(s)`,
    ...result.clusters.map((cluster) => {
      return `${cluster.name}: ${cluster.states.join(", ")} -> ${cluster.recommendation} (${cluster.confidence})`;
    }),
  ].join("\n");
  output(args, result, text);
}

function commandRefactorState(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "refactor-state <file>");
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }
  const externalDeps = stringFlag(args, "external-deps") ?? "fail";
  if (externalDeps !== "fail" && externalDeps !== "params") {
    throw new Error("refactor-state --external-deps must be fail or params.");
  }
  const options = {
    cluster: stringFlag(args, "cluster"),
    to: stringFlag(args, "to"),
    name: stringFlag(args, "name"),
    externalDeps: externalDeps as "fail" | "params",
  };
  const planOut = stringFlag(args, "plan-out");
  if (planOut) {
    if (args.flags.write) throw new Error("refactor-state --plan-out only writes the plan file; apply it with tedit apply-plan.");
    const plan = buildRefactorStatePlan(filePath, options);
    writePlanFile(planOut, plan, Boolean(args.flags.overwrite));
    const result = { success: true, plan: planOut, ...plan };
    output(args, result, JSON.stringify(result, null, 2));
    return;
  }

  const result = runRefactorState(filePath, {
    ...options,
    ...writeFlags(args),
  });
  output(args, result, JSON.stringify(result, null, 2));
}

function commandFind(args: ParsedArgs): void {
  const [filePath, selector] = requirePositionals(args, 2, "find <file> <selector>");
  const doc = openDocumentForFile(filePath);
  const matches = doc.find(selector);
  output(args, { success: true, matches }, formatMatches(matches));
}

function commandInspect(args: ParsedArgs): void {
  const [filePath, rawTarget] = requirePositionals(args, 1, "inspect <file> [selector]");
  const target = stringFlag(args, "id") ?? rawTarget;
  if (!target) throw new Error("inspect requires --id or selector.");

  const doc = openDocumentForFile(filePath);
  const info = doc.inspect(target);
  output(args, { success: true, node: info }, JSON.stringify(info, null, 2));
}

function commandInsert(args: ParsedArgs, action: "append" | "prepend"): void {
  const [filePath, rawTarget] = requirePositionals(args, 1, `${action} <file> <selector> --element <json>`);
  const target = stringFlag(args, "id") ?? rawTarget;
  if (!target) throw new Error(`${action} requires --id or selector.`);

  const element = parseJsonFlag<TreeNodeSpec>(args, "element");
  const doc = openDocumentForFile(filePath);
  const result = action === "append" ? doc.append(target, element) : doc.prepend(target, element);
  finishMutation(args, doc, result);
}

function commandWrap(args: ParsedArgs): void {
  const [filePath, rawTarget] = requirePositionals(args, 1, "wrap <file> <selector> --with <tag-or-json>");
  const target = stringFlag(args, "id") ?? rawTarget;
  if (!target) throw new Error("wrap requires --id or selector.");

  const raw = stringFlag(args, "with");
  if (!raw) throw new Error("wrap requires --with.");

  const wrapper = raw.trim().startsWith("{") ? JSON.parse(raw) as TreeNodeSpec : { tag: raw };
  const doc = openDocumentForFile(filePath);
  const result = doc.wrap(target, wrapper);
  finishMutation(args, doc, result);
}

function commandTargetOnly(args: ParsedArgs, action: "unwrap" | "remove"): void {
  const [filePath, rawTarget] = requirePositionals(args, 1, `${action} <file> <selector>`);
  const target = stringFlag(args, "id") ?? rawTarget;
  if (!target) throw new Error(`${action} requires --id or selector.`);

  const doc = openDocumentForFile(filePath);
  const result = action === "unwrap" ? doc.unwrap(target) : (doc.remove(target), { removed: true });
  finishMutation(args, doc, result);
}

function commandRename(args: ParsedArgs): void {
  const [filePath, rawTarget] = requirePositionals(args, 1, "rename <file> <selector> --to <name>");
  const target = stringFlag(args, "id") ?? rawTarget;
  const to = stringFlag(args, "to");
  if (!target || !to) throw new Error("rename requires --id or selector plus --to.");

  const doc = openDocumentForFile(filePath);
  const result = doc.rename(target, to);
  finishMutation(args, doc, result);
}

function commandInsertComment(args: ParsedArgs): void {
  const [filePath, rawTarget, ...textParts] = requirePositionals(args, 2, "insertComment <file> <selector> <text>");
  const target = stringFlag(args, "id") ?? rawTarget;
  const text = stringFlag(args, "text") ?? textParts.join(" ");
  const position = stringFlag(args, "position") as "inside-start" | "inside-end" | "before" | "after" | undefined;
  if (!target || !text) throw new Error("insertComment requires --id or selector plus text.");

  const doc = openDocumentForFile(filePath);
  const result = doc.insertComment(target, text, position);
  finishMutation(args, doc, result);
}

function commandText(args: ParsedArgs): void {
  const [subcommand, filePath, rawTarget] = args.positionals;
  if (!["set", "replace"].includes(subcommand ?? "")) {
    throw new Error("text requires set or replace.");
  }
  const target = stringFlag(args, "id") ?? rawTarget;
  if (!filePath || !target) throw new Error("text usage: text set|replace <file> <selector>");

  const doc = openDocumentForFile(filePath);
  const result = subcommand === "set"
    ? doc.setText(target, parseTextValueFlags(args, "text.set"))
    : doc.replaceText(target, parseTextMatchFlags(args), parseTextReplacementFlags(args));
  finishMutation(args, doc, result);
}

function commandProp(args: ParsedArgs): void {
  const [subcommand, filePath, rawTarget, name, rawValue] = args.positionals;
  if (!["set", "remove"].includes(subcommand ?? "")) {
    throw new Error("prop requires `set` or `remove`.");
  }

  const target = stringFlag(args, "id") ?? rawTarget;
  if (!filePath || !target || !name) throw new Error("prop usage: prop set|remove <file> <selector> <name> [value]");

  const doc = openDocumentForFile(filePath);
  const result = subcommand === "set"
    ? doc.setAttribute(target, name, parsePropValue(args, rawValue))
    : doc.removeAttribute(target, name);

  finishMutation(args, doc, result);
}

function commandClass(args: ParsedArgs): void {
  const [subcommand, filePath, rawTarget, ...classParts] = args.positionals;
  if (!["add", "remove", "replace"].includes(subcommand ?? "")) {
    throw new Error("class requires add, remove, or replace.");
  }

  const target = stringFlag(args, "id") ?? rawTarget;
  if (!filePath || !target) throw new Error("class usage: class add|remove|replace <file> <selector> <class...>");

  const doc = openDocumentForFile(filePath);
  const result =
    subcommand === "add" ? doc.addClass(target, classNamesFromArgs(args, classParts)) :
    subcommand === "remove" ? doc.removeClass(target, classNamesFromArgs(args, classParts)) :
    doc.replaceClass(target, requiredClassReplaceArg(args, "from", classParts[0]), requiredClassReplaceArg(args, "to", classParts[1]));

  finishMutation(args, doc, result);
}

function classNamesFromArgs(args: ParsedArgs, positionals: string[]): string {
  const flag = stringFlag(args, "classes");
  const value = flag ?? positionals.join(" ");
  if (!value.trim()) throw new Error("class add/remove requires at least one class name.");
  return value;
}

function requiredClassReplaceArg(args: ParsedArgs, name: "from" | "to", positional: string | undefined): string {
  const value = stringFlag(args, name) ?? positional;
  if (!value) throw new Error(`class.replace requires --${name} or positional <${name}>.`);
  return value;
}

function commandImports(args: ParsedArgs): void {
  const [subcommand, filePath] = args.positionals;
  if (!["add", "remove", "rename", "move"].includes(subcommand ?? "")) {
    throw new Error("imports requires add, remove, rename, or move.");
  }
  if (!filePath) throw new Error("imports usage: imports add|remove|rename|move <file> --from <source>");

  const spec = parseImportSpec(args);
  const doc = openDocumentForFile(filePath);
  const result =
    subcommand === "add" ? doc.addImport(spec) :
    subcommand === "remove" ? doc.removeImport(spec) :
    subcommand === "rename" ? doc.renameImport(spec) :
    doc.moveImport(spec);

  finishMutation(args, doc, result);
}

function commandExpr(args: ParsedArgs): void {
  const [subcommand, filePath, rawTarget] = args.positionals;
  if (!["replace", "wrap", "unwrap", "toTernary", "toShortCircuit"].includes(subcommand ?? "")) {
    throw new Error("expr requires replace, wrap, unwrap, toTernary, or toShortCircuit.");
  }
  const target = stringFlag(args, "id") ?? rawTarget;
  if (!filePath || !target) throw new Error("expr usage: expr <action> <file> <selector>");

  const doc = openDocumentForFile(filePath);
  const result =
    subcommand === "replace" ? doc.replaceExpression(target, requiredStringFlag(args, "code", "expr.replace requires --code.")) :
    subcommand === "wrap" ? doc.wrapExpression(target, requiredStringFlag(args, "code", "expr.wrap requires --code.")) :
    subcommand === "unwrap" ? doc.unwrapExpression(target) :
    subcommand === "toTernary" ? doc.toTernaryExpression(target, stringFlag(args, "alternate")) :
    doc.toShortCircuitExpression(target);
  finishMutation(args, doc, result);
}

function commandExtract(args: ParsedArgs): void {
  const [filePath, selector] = requirePositionals(args, 2, "extract <file> <selector> --to <new-file> --name <ComponentName>");
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }

  const exportFlag = stringFlag(args, "export") ?? "named";
  if (exportFlag !== "named" && exportFlag !== "default") {
    throw new Error("extract --export must be named or default.");
  }
  const helpersPolicy = stringFlag(args, "helpers") ?? "ask";
  if (!["ask", "move", "share", "as-prop"].includes(helpersPolicy)) {
    throw new Error("extract --helpers must be ask, move, share, or as-prop.");
  }

  const depth = stringFlag(args, "depth");
  if (depth !== undefined && !Number.isInteger(Number(depth))) {
    throw new Error("extract --depth must be an integer.");
  }
  const maxProps = stringFlag(args, "max-props");
  if (maxProps !== undefined && !Number.isInteger(Number(maxProps))) {
    throw new Error("extract --max-props must be an integer.");
  }
  const plan = planExtract({
    from: filePath,
    selector,
    to: requiredStringFlag(args, "to", "extract requires --to."),
    name: requiredStringFlag(args, "name", "extract requires --name."),
    exportKind: exportFlag,
    slots: stringFlags(args, "slot"),
    ...(depth === undefined ? {} : { depth: Number(depth) }),
    autoSlot: Boolean(args.flags["auto-slot"]),
    typecheck: Boolean(args.flags.typecheck),
    helpersPolicy: helpersPolicy as HelperPolicy,
    helperOverrides: stringFlags(args, "helper"),
    overwrite: Boolean(args.flags.overwrite),
    acceptLargeProps: Boolean(args.flags["accept-large-props"]),
    ...(maxProps === undefined ? {} : { maxProps: Number(maxProps) }),
  });

  const planOut = stringFlag(args, "plan-out");
  if (planOut) {
    if (args.flags.write) throw new Error("extract --plan-out only writes the plan file; apply it with tedit apply-plan.");
    const refactorPlan = buildExtractComponentPlan({
      from: filePath,
      selector,
      to: requiredStringFlag(args, "to", "extract requires --to."),
      name: requiredStringFlag(args, "name", "extract requires --name."),
      exportKind: exportFlag,
      slots: stringFlags(args, "slot"),
      ...(depth === undefined ? {} : { depth: Number(depth) }),
      autoSlot: Boolean(args.flags["auto-slot"]),
      typecheck: Boolean(args.flags.typecheck),
      helpersPolicy: helpersPolicy as HelperPolicy,
      helperOverrides: stringFlags(args, "helper"),
      overwrite: Boolean(args.flags.overwrite),
      acceptLargeProps: Boolean(args.flags["accept-large-props"]),
      ...(maxProps === undefined ? {} : { maxProps: Number(maxProps) }),
    }, plan);
    writePlanFile(planOut, refactorPlan, Boolean(args.flags.overwrite));
    const result = { success: true, plan: planOut, ...refactorPlan };
    output(args, result, JSON.stringify(result, null, 2));
    return;
  }

  const sourceDiff = unifiedDiff(plan.source, plan.nextSource, filePath);
  const targetExisted = existsSync(plan.result.to);
  const previousNewSource = targetExisted ? readFileSync(plan.result.to, "utf8") : "";
  const newFileDiff = unifiedDiff(previousNewSource, plan.newSource, plan.result.to);
  const warnings = [
    ...qualityWarnings(filePath, plan.source, plan.nextSource),
    ...qualityWarnings(plan.result.to, previousNewSource, plan.newSource),
  ];
  const sourcePolicy = resolveWritePolicy(filePath, writeFlags(args));
  const targetPolicy = resolveWritePolicy(plan.result.to, writeFlags(args));
  const shouldWrite = sourcePolicy.write && targetPolicy.write;
  let sourceBackup: BackupResult = {};
  let targetBackup: BackupResult = {};

  if (shouldWrite) {
    sourceBackup = maybeWriteBackup(filePath, plan.source, sourcePolicy, plan.source !== plan.nextSource, plan.nextSource);
    targetBackup = maybeWriteBackup(plan.result.to, previousNewSource, targetPolicy, previousNewSource !== plan.newSource, plan.newSource);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, plan.nextSource);
    mkdirSync(dirname(plan.result.to), { recursive: true });
    writeFileSync(plan.result.to, plan.newSource);
  }

  const result = {
    ...plan.result,
    success: true,
    changed: plan.source !== plan.nextSource || previousNewSource !== plan.newSource,
    written: shouldWrite,
    warnings,
    files: [
      { file: filePath, existed: true, changed: plan.source !== plan.nextSource, written: shouldWrite, warnings: qualityWarnings(filePath, plan.source, plan.nextSource), write_policy: writePolicyReport(sourcePolicy, sourceBackup), ...(sourceBackup.path ? { backup: sourceBackup.path } : {}), ...(sourceDiff ? { diff: sourceDiff } : {}) },
      { file: plan.result.to, existed: targetExisted, changed: previousNewSource !== plan.newSource, written: shouldWrite, warnings: qualityWarnings(plan.result.to, previousNewSource, plan.newSource), write_policy: writePolicyReport(targetPolicy, targetBackup), ...(targetBackup.path ? { backup: targetBackup.path } : {}), ...(newFileDiff ? { diff: newFileDiff } : {}) },
    ],
    write_policy: {
      source: writePolicyReport(sourcePolicy, sourceBackup),
      newFile: writePolicyReport(targetPolicy, targetBackup),
    },
    diffs: {
      source: sourceDiff,
      newFile: newFileDiff,
    },
  };
  output(args, result, JSON.stringify(result, null, 2));
}

function commandPlan(args: ParsedArgs): void {
  const [action, planPath] = requirePositionals(args, 2, "plan inspect <plan-json>");
  if (action !== "inspect") throw new Error("Unknown plan action: " + action);
  const result = inspectRefactorPlan(planPath);
  output(args, result, formatPlanInspect(result));
}

function commandApplyPlan(args: ParsedArgs): void {
  const [planPath] = requirePositionals(args, 1, "apply-plan <plan-json>");
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }
  const result = applyRefactorPlan(planPath, {
    ...writeFlags(args),
    overwrite: Boolean(args.flags.overwrite),
    only: stringFlags(args, "only"),
    skip: stringFlags(args, "skip"),
  });
  writeDiffOut(args, result);
  if (quietRequested(args)) return;
  output(args, result, JSON.stringify(result, null, 2));
}

function commandCreate(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "create <file> --source <source>");
  const source = readSourceInput(args, "create");
  finishCreation(args, filePath, source, { kind: "create" });
}

function commandWrite(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "write <file> --source <source>");
  const source = readSourceInput(args, "write");
  finishCreation(args, filePath, source, { kind: "write" });
}

function commandScaffold(args: ParsedArgs): void {
  const [filePath] = requirePositionals(args, 1, "scaffold <file> --spec <json-or-file>");
  const spec = stringFlag(args, "spec") ? loadScaffoldSpec(requiredStringFlag(args, "spec", "scaffold requires --spec or CLI scaffold flags.")) : scaffoldSpecFromFlags(args);
  const source = buildScaffoldSource(spec);
  finishCreation(args, filePath, source, { kind: "scaffold", spec });
}

function commandNew(args: ParsedArgs): void {
  const [templateName, filePath] = requirePositionals(args, 2, "new <template> <file>");
  const params = parseParams(stringFlags(args, "param"));
  const spec = loadTemplateSpec(templateName, params, stringFlag(args, "cwd") ?? process.cwd());
  const source = buildScaffoldSource(spec);
  finishCreation(args, filePath, source, { kind: "new", template: templateName, spec });
}

function commandTemplates(args: ParsedArgs): void {
  const cwd = stringFlag(args, "cwd") ?? process.cwd();
  const templates = listTemplates(cwd);
  output(args, { success: true, kind: "templates", cwd, templates, count: templates.length }, templates.map((template) => {
    return `${template.name} (${template.source})${template.path ? ` ${template.path}` : ""}`;
  }).join("\n"));
}

function commandFlow(args: ParsedArgs): void {
  const [filePath, flowPath] = requirePositionals(args, 2, "flow <file> <flow-json>");
  const doc = openDocumentForFile(filePath);
  const root = parseFlowInput(flowPath);
  const params = loadParams(stringFlag(args, "params"));
  const result = runFlow(doc, root.flow, params);
  finishMutation(args, doc, result);
}

function commandWorkspaceFlow(args: ParsedArgs): void {
  const [flowPath] = requirePositionals(args, 1, "workspace-flow <flow-json>");
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }

  const root = parseFlowInput(flowPath);
  const params = loadParams(stringFlag(args, "params"));
  const result = runWorkspaceFlow(root.flow as WorkspaceFlowStep[], {
    params,
    ...writeFlags(args),
  });
  output(args, result, JSON.stringify(result, null, 2));
}

function commandMultiedit(args: ParsedArgs): void {
  const input = readFileOrStdinInput(args, "multiedit <edits-json>");
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }

  if (quietRequested(args)) {
    const result = runMultieditInput(input, writeFlags(args));
    writeDiffOut(args, result);
    return;
  }

  if (!summaryRequested(args)) {
    const result = runMultieditInput(input, writeFlags(args));
    writeDiffOut(args, result);
    output(args, result, JSON.stringify(result, null, 2));
    return;
  }

  const edits = parseMultieditInput(input);
  try {
    const result = runMultiedit(edits, writeFlags(args));
    writeDiffOut(args, result);
    process.stdout.write(formatMultieditSummary(result, edits, summarySpecName(args), summaryMode(args)) + "\n");
  } catch (error) {
    const result = toErrorResult(error);
    process.stdout.write(formatMultieditFailureSummary(result, edits, summarySpecName(args)) + "\n");
    process.exitCode = 1;
  }
}

function commandVerify(args: ParsedArgs): void {
  if (args.flags.write) throw new Error("verify is always a dry-run; do not pass --write.");
  const input = readFileOrStdinInput(args, "verify <edits-json>");
  const edits = parseMultieditInput(input);
  try {
    const result = runMultiedit(edits, { ...writeFlags(args), dryRun: true, write: false });
    writeDiffOut(args, result);
    if (quietRequested(args)) return;
    if (args.flags.json) {
      output(args, result, JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(formatMultieditSummary(result, edits, summarySpecName(args), summaryModeOrDefault(args)) + "\n");
  } catch (error) {
    const result = toErrorResult(error);
    if (quietRequested(args)) process.stderr.write(JSON.stringify(result, null, 2) + "\n");
    else if (args.flags.json) output(args, result, JSON.stringify(result, null, 2));
    else process.stdout.write(formatMultieditFailureSummary(result, edits, summarySpecName(args)) + "\n");
    process.exitCode = 1;
  }
}

function commandVerifyFile(args: ParsedArgs): void {
  const filePaths = requirePositionals(args, 1, "verify-file <file...>");
  const result = verifyFilePaths(filePaths);
  output(args, result, formatVerifyFileResult(result));
}

function verifyFilePaths(filePaths: string[]): Record<string, unknown> {
  const files = filePaths.map(verifyFileEntry);
  if (files.length === 1) {
    return {
      success: true,
      ...files[0],
    };
  }
  return {
    success: true,
    kind: "verify-files",
    files,
    count: files.length,
    verifiedCount: files.filter((file) => file.parse_verified === true).length,
    skippedCount: files.filter((file) => file.parse_skipped === true).length,
    warningCount: files.reduce((count, file) => count + file.warnings.length, 0),
  };
}

function verifyFileEntry(filePath: string): VerifyFileEntry {
  const source = readFileSync(filePath, "utf8");
  const verification = verifyParseForFile(filePath, source);
  return {
    file: filePath,
    ...parseVerificationFields(verification),
    warnings: qualityWarnings(filePath, source, source),
  };
}

function formatVerifyFileResult(result: Record<string, unknown>): string {
  if (Array.isArray(result.files)) {
    const verified = typeof result.verifiedCount === "number" ? result.verifiedCount : 0;
    const skipped = typeof result.skippedCount === "number" ? result.skippedCount : 0;
    const count = typeof result.count === "number" ? result.count : result.files.length;
    const parts = [`${count} files checked`, `${verified} parse verified`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    return parts.join("; ");
  }
  if (result.parse_verified === true) return `${result.file}: parse verified (${result.parser})`;
  return `${result.file}: no parser registered`;
}

function commandPatch(args: ParsedArgs): void {
  const input = readFileOrStdinInput(args, "patch <patch-file>", ["from-stdin", "stdin"]);
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }

  const result = runPatchInput(input, writeFlags(args));
  writeDiffOut(args, result);
  if (quietRequested(args)) return;
  output(args, result, JSON.stringify(result, null, 2));
}

function commandChain(args: ParsedArgs): void {
  const [filePath, ...chainArgs] = requirePositionals(args, 1, "chain <file> <action> [args...] [:: <action> [args...] ...]");
  const fromFile = stringFlag(args, "from-file");
  const fromStdin = Boolean(args.flags["from-stdin"]);
  if (fromFile && fromStdin) throw new Error("Use only one of --from-file or --from-stdin.");
  if ((fromFile || fromStdin) && chainArgs.length > 0) {
    throw new Error("Do not pass inline chain steps with --from-file or --from-stdin.");
  }

  const segments = fromFile
    ? parseChainText(readFileSync(fromFile, "utf8"))
    : fromStdin
      ? parseChainText(readFileSync(0, "utf8"))
      : parseChainSegments(requireChainArgs(chainArgs));

  if (segments.some((segment) => ["create", "write", "edit"].includes(segment.action))) {
    const result = runWorkspaceFlow(fileChainToWorkspaceFlow(filePath, segments), writeFlags(args));
    output(args, result, JSON.stringify(result, null, 2));
    return;
  }
  const doc = openDocumentForFile(filePath);
  const steps = chainToFlow(segments);
  const result = runFlow(doc, steps);
  finishMutation(args, doc, result);
}

function commandWorkspaceChain(args: ParsedArgs): void {
  const fromFile = stringFlag(args, "from-file");
  const fromStdin = Boolean(args.flags["from-stdin"]);
  if (fromFile && fromStdin) throw new Error("Use only one of --from-file or --from-stdin.");
  if ((fromFile || fromStdin) && args.positionals.length > 0) {
    throw new Error("Do not pass inline chain steps with --from-file or --from-stdin.");
  }
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }

  const segments = fromFile
    ? parseChainText(readFileSync(fromFile, "utf8"))
    : fromStdin
      ? parseChainText(readFileSync(0, "utf8"))
      : parseChainSegments(requireChainArgs(args.positionals));
  const steps = workspaceChainToFlow(segments);
  const params = loadParams(stringFlag(args, "params"));
  const result = runWorkspaceFlow(steps, {
    params,
    ...writeFlags(args),
  });
  output(args, result, JSON.stringify(result, null, 2));
}

function commandBackups(args: ParsedArgs): void {
  const [action, id] = args.positionals;
  const root = stringFlag(args, "root") ?? process.cwd();
  if (!action || action === "list") {
    printJson(listBackups(root));
    return;
  }
  if (action === "restore") {
    if (!id) throw new Error("backups restore requires a backup id.");
    printJson(restoreBackup(id, { root, write: Boolean(args.flags.write), dryRun: Boolean(args.flags["dry-run"]) }));
    return;
  }
  if (action === "clean") {
    printJson(cleanBackups({
      root,
      olderThan: requiredStringFlag(args, "older-than", "backups clean requires --older-than <duration>."),
      write: Boolean(args.flags.write),
      dryRun: Boolean(args.flags["dry-run"]),
    }));
    return;
  }
  throw new Error("Unknown backups action: " + action);
}

function commandRules(args: ParsedArgs): void {
  const rules = listRules();
  output(args, { success: true, rules }, rules.map((rule) => {
    return `${rule.name}: ${rule.extensions.join(", ")} (${rule.actions.join(", ")})`;
  }).join("\n"));
}

function finishMutation(args: ParsedArgs, doc: { filePath: string; source: string; print(): string }, result: unknown): void {
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }

  const next = doc.print();
  const changed = next !== doc.source;
  const diff = unifiedDiff(doc.source, next, doc.filePath);
  const warnings = qualityWarnings(doc.filePath, doc.source, next);
  const policy = resolveWritePolicy(doc.filePath, writeFlags(args));
  const shouldWrite = policy.write;
  let backup: BackupResult = {};

  if (shouldWrite && changed) {
    backup = maybeWriteBackup(doc.filePath, doc.source, policy, changed, next);
    writeFileSync(doc.filePath, next);
  }

  output(
    args,
    { success: true, file: doc.filePath, changed, written: shouldWrite && changed, result, warnings, write_policy: writePolicyReport(policy, backup), ...(backup.path ? { backup: backup.path } : {}), ...(diff ? { diff } : {}) },
    withWarnings(
      withWritePolicyNotes(
        shouldWrite
          ? `${changed ? "Wrote" : "No changes"}: ${doc.filePath}`
          : diff || "No changes",
        policy,
        backup,
      ),
      warnings,
    ),
  );
}

function finishCreation(args: ParsedArgs, filePath: string, source: string, result: unknown): void {
  if (args.flags.write && args.flags["dry-run"]) {
    throw new Error("Use only one of --write or --dry-run.");
  }
  const existed = existsSync(filePath);
  if (existed && !args.flags.overwrite) {
    throw new Error(`Refusing to overwrite existing file: ${filePath}. Use --overwrite to bypass.`);
  }

  const parseVerification = verifyParseForFile(filePath, source);

  const previous = existed ? readFileSync(filePath, "utf8") : "";
  const changed = previous !== source;
  const diff = unifiedDiff(previous, source, filePath);
  const warnings = qualityWarnings(filePath, previous, source);
  const policy = resolveWritePolicy(filePath, writeFlags(args));
  const shouldWrite = policy.write;
  let backup: BackupResult = {};

  if (shouldWrite && changed) {
    backup = maybeWriteBackup(filePath, previous, policy, changed, source);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  }

  output(
    args,
    {
      success: true,
      file: filePath,
      existed,
      changed,
      written: shouldWrite && changed,
      ...parseVerificationFields(parseVerification),
      result,
      warnings,
      write_policy: writePolicyReport(policy, backup),
      ...(diff ? { diff } : {}),
    },
    withWarnings(
      withWritePolicyNotes(
        shouldWrite
          ? `${changed ? "Wrote" : "No changes"}: ${filePath}`
          : diff || source,
        policy,
        backup,
      ),
      warnings,
    ),
  );
}

function readSourceInput(args: ParsedArgs, label: string): string {
  const source = stringFlag(args, "source");
  const fromFile = stringFlag(args, "from-file");
  const fromStdin = Boolean(args.flags["from-stdin"]);
  const count = [source !== undefined, fromFile !== undefined, fromStdin].filter(Boolean).length;
  if (count !== 1) throw new Error(`${label} requires exactly one of --source, --from-file, or --from-stdin.`);
  if (source !== undefined) return source.endsWith("\n") ? source : `${source}\n`;
  if (fromFile !== undefined) return readFileSync(fromFile, "utf8");
  return readFileSync(0, "utf8");
}

function readFileOrStdinInput(args: ParsedArgs, usage: string, stdinFlags = ["from-stdin"]): string {
  const presentStdinFlags = stdinFlags.filter((flag) => Boolean(args.flags[flag]));
  if (presentStdinFlags.length > 1) throw new Error(`Use only one of ${stdinFlags.map((flag) => `--${flag}`).join(" or ")}.`);
  const fromStdin = presentStdinFlags.length === 1;
  if (fromStdin && args.positionals.length > 0) throw new Error(`Do not pass ${usage} with --from-stdin.`);
  if (fromStdin) return readFileSync(0, "utf8");
  const [filePath] = requirePositionals(args, 1, usage);
  return readFileSync(filePath, "utf8");
}

function scaffoldSpecFromFlags(args: ParsedArgs): ScaffoldSpec {
  const body = stringFlag(args, "body");
  const exports = stringFlags(args, "export").map((item) => parseScaffoldExport(item, body));
  if (exports.length === 0 && body) {
    exports.push(parseScaffoldExport("function:Component()", body));
  }
  return {
    directives: stringFlags(args, "directives"),
    imports: stringFlags(args, "imports").map(parseScaffoldImport),
    exports: exports as ScaffoldExportSpec[],
  };
}

function parsePropValue(args: ParsedArgs, rawValue: string | undefined): ValueSpec {
  if (args.flags.expr) return { type: "expr", code: String(args.flags.expr) };
  if (rawValue === undefined) return true;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue.trim().startsWith("{")) return JSON.parse(rawValue) as ValueSpec;
  return rawValue;
}

function parseTextValueFlags(args: ParsedArgs, label: string): TextValueSpec {
  const value = stringFlag(args, "value");
  const expr = stringFlag(args, "expr");
  if ((value === undefined) === (expr === undefined)) {
    throw new Error(`${label} requires exactly one of --value or --expr.`);
  }
  return expr === undefined ? { kind: "text", value: value ?? "" } : { kind: "expr", code: expr };
}

function parseTextMatchFlags(args: ParsedArgs): TextMatchSpec {
  const text = stringFlag(args, "match-text");
  const expr = stringFlag(args, "match-expr");
  const any = stringFlag(args, "match-any");
  const count = [text !== undefined, expr !== undefined, any !== undefined].filter(Boolean).length;
  if (count !== 1) throw new Error("text.replace requires exactly one of --match-text, --match-expr, or --match-any.");
  if (text !== undefined) return { kind: "text", value: text };
  if (expr !== undefined) return { kind: "expr", code: expr };
  return { kind: "any", value: any ?? "" };
}

function parseTextReplacementFlags(args: ParsedArgs): TextValueSpec {
  const text = stringFlag(args, "with-text");
  const expr = stringFlag(args, "with-expr");
  if ((text === undefined) === (expr === undefined)) {
    throw new Error("text.replace requires exactly one of --with-text or --with-expr.");
  }
  return expr === undefined ? { kind: "text", value: text ?? "" } : { kind: "expr", code: expr };
}

function parseImportSpec(args: ParsedArgs): ImportEditSpec {
  const from = stringFlag(args, "from");
  if (!from) throw new Error("imports requires --from.");
  return {
    from,
    ...(stringFlag(args, "to") ? { to: stringFlag(args, "to") } : {}),
    ...(stringFlag(args, "named") ? { named: stringFlag(args, "named") } : {}),
    ...(stringFlag(args, "default") ? { default: stringFlag(args, "default") } : {}),
    ...(stringFlag(args, "namespace") ? { namespace: stringFlag(args, "namespace") } : {}),
    ...(stringFlag(args, "name") ? { name: stringFlag(args, "name") } : {}),
    ...(stringFlag(args, "value") ? { value: stringFlag(args, "value") } : {}),
  };
}

function parseBaseFindStrategy(args: ParsedArgs, spec?: EditSpec): BaseFindStrategy {
  const find = readEditTextInput(args, spec, "find", ["find"], [
    { flag: "find", kind: "inline" },
    { flag: "find-file", kind: "file" },
    { flag: "find-stdin", kind: "stdin" },
  ]);
  const findExact = readEditTextInput(args, spec, "findExact", ["findExact", "find-exact", "find_exact"], [
    { flag: "find-exact", kind: "inline" },
    { flag: "find-exact-file", kind: "file" },
    { flag: "find-exact-stdin", kind: "stdin" },
  ]);
  const findFuzzy = readEditTextInput(args, spec, "findFuzzy", ["findFuzzy", "find-fuzzy", "find_fuzzy"], [
    { flag: "find-fuzzy", kind: "inline" },
    { flag: "find-fuzzy-file", kind: "file" },
    { flag: "find-fuzzy-stdin", kind: "stdin" },
  ]);
  const findAnchor = readEditTextInput(args, spec, "findAnchorAfter", ["findAnchorAfter", "find-anchor-after", "find_anchor_after"], [
    { flag: "find-anchor-after", kind: "inline" },
    { flag: "find-anchor-after-file", kind: "file" },
    { flag: "find-anchor-after-stdin", kind: "stdin" },
  ]);
  const findRegex = readEditTextInput(args, spec, "findRegex", ["findRegex", "find-regex", "find_regex"], [
    { flag: "find-regex", kind: "inline" },
    { flag: "find-regex-file", kind: "file" },
    { flag: "find-regex-stdin", kind: "stdin" },
  ]);
  const findLines = inputValue(args, spec, ["findLines", "find-lines", "find_lines"], "find-lines");
  const strategyCount = [findExact.present, findFuzzy.present, findAnchor.present, findRegex.present, findLines.present].filter(Boolean).length;

  if (strategyCount > 1) throw new Error("edit accepts only one find strategy.");
  if (findAnchor.present && (findExact.present || findFuzzy.present || findRegex.present || findLines.present)) {
    throw new Error("--find-anchor-after cannot be combined with another find strategy.");
  }
  if (!findAnchor.present && find.present && strategyCount > 0) {
    throw new Error("--find is only an alias for exact matching, or the contained text for --find-anchor-after.");
  }

  if (findAnchor.present) {
    const contains = readEditTextInput(args, spec, "contains", ["contains"], [
      { flag: "contains", kind: "inline" },
      { flag: "contains-file", kind: "file" },
      { flag: "contains-stdin", kind: "stdin" },
    ]);
    const anchorContains = contains.present ? contains : find;
    if (!anchorContains.present) throw new Error("--find-anchor-after requires --find or --contains.");
    return {
      kind: "anchor",
      after: findAnchor.value,
      contains: anchorContains.value,
    };
  }
  if (findExact.present) {
    return {
      kind: "exact",
      pattern: findExact.value,
      autoFuzzy: !args.flags["no-fuzzy-fallback"],
    };
  }
  if (findFuzzy.present) {
    return {
      kind: "fuzzy",
      pattern: findFuzzy.value,
      ignoreWhitespace: true,
    };
  }
  if (findRegex.present) {
    const flags = inputValue(args, spec, ["flags"], "flags");
    return {
      kind: "regex",
      pattern: findRegex.value,
      ...(flags.present ? { flags: String(flags.value) } : {}),
    };
  }
  if (findLines.present) {
    const range = parseLineRange(String(findLines.value));
    return { kind: "lines", ...range };
  }
  if (find.present) {
    return {
      kind: "exact",
      pattern: find.value,
      autoFuzzy: !args.flags["no-fuzzy-fallback"],
    };
  }

  throw new Error("edit requires --find, --find-exact, --find-fuzzy, --find-anchor-after, --find-regex, or --find-lines.");
}

function parseBaseMutation(args: ParsedArgs, spec?: EditSpec): BaseEditMutation {
  const replace = readEditTextInput(args, spec, "replace", ["replace"], [
    { flag: "replace", kind: "inline" },
    { flag: "replace-file", kind: "file" },
    { flag: "replace-stdin", kind: "stdin" },
  ]);
  const insertBefore = readEditTextInput(args, spec, "insertBefore", ["insertBefore", "insert-before", "insert_before"], [
    { flag: "insert-before", kind: "inline" },
    { flag: "insert-before-file", kind: "file" },
    { flag: "insert-before-stdin", kind: "stdin" },
  ]);
  const insertAfter = readEditTextInput(args, spec, "insertAfter", ["insertAfter", "insert-after", "insert_after"], [
    { flag: "insert-after", kind: "inline" },
    { flag: "insert-after-file", kind: "file" },
    { flag: "insert-after-stdin", kind: "stdin" },
  ]);
  const shouldDelete = booleanInput(args, spec, "delete", ["delete"]);
  const count = [replace.present, insertBefore.present, insertAfter.present, shouldDelete].filter(Boolean).length;
  if (count !== 1) {
    throw new Error("edit requires exactly one of --replace, --insert-before, --insert-after, or --delete.");
  }
  if (replace.present) return { kind: "replace", text: replace.value };
  if (insertBefore.present) return { kind: "insert-before", text: insertBefore.value };
  if (insertAfter.present) return { kind: "insert-after", text: insertAfter.value };
  return { kind: "delete" };
}

type EditTextInputSource = {
  flag: string;
  kind: "inline" | "file" | "stdin";
};

type InputValueResult = { present: true; value: unknown } | { present: false };
type TextInputResult = { present: true; value: string } | { present: false };

function loadEditSpec(args: ParsedArgs): EditSpec | undefined {
  const raw = stringFlag(args, "spec");
  if (raw === undefined) return undefined;

  const root = loadJsonOrFile(raw, "edit spec");
  const spec = normalizeSingleEditSpec(root);
  return spec;
}

function normalizeSingleEditSpec(root: unknown): EditSpec {
  if (Array.isArray(root)) {
    if (root.length !== 1) throw new Error("edit --spec array must contain exactly one edit.");
    return normalizeSingleEditSpec(root[0]);
  }
  if (root && typeof root === "object" && Array.isArray((root as { edits?: unknown }).edits)) {
    const edits = (root as { edits: unknown[] }).edits;
    if (edits.length !== 1) throw new Error("edit --spec edits array must contain exactly one edit.");
    return normalizeSingleEditSpec(edits[0]);
  }
  if (!root || typeof root !== "object") throw new Error("edit --spec must be a JSON object.");
  return root as EditSpec;
}

function resolveEditFilePath(args: ParsedArgs, spec?: EditSpec): string {
  if (args.positionals.length > 1) throw new Error("Usage: tedit edit <file> --find <text> --replace <text>");
  const positional = args.positionals[0];
  const specFile = specString(spec, ["file"]);
  if (positional && specFile && positional !== specFile) {
    throw new Error("edit file positional and --spec file must match.");
  }
  const filePath = positional ?? specFile;
  if (!filePath) throw new Error("Usage: tedit edit <file> --find <text> --replace <text>");
  return filePath;
}

function ensureSingleEditStdin(args: ParsedArgs): void {
  const stdinFlags = [
    "find-stdin",
    "find-exact-stdin",
    "find-fuzzy-stdin",
    "find-anchor-after-stdin",
    "find-regex-stdin",
    "contains-stdin",
    "replace-stdin",
    "insert-before-stdin",
    "insert-after-stdin",
  ].filter((flag) => Boolean(args.flags[flag]));
  if (stdinFlags.length > 1) {
    throw new Error(`Use only one stdin-backed edit input flag at a time: ${stdinFlags.map((flag) => `--${flag}`).join(", ")}.`);
  }
}

function readEditTextInput(args: ParsedArgs, spec: EditSpec | undefined, label: string, specKeys: string[], sources: EditTextInputSource[]): TextInputResult {
  const values: string[] = [];

  const specValue = specInputValue(spec, specKeys);
  if (specValue.present) values.push(String(specValue.value));

  for (const source of sources) {
    if (source.kind === "inline" && flagValuePresent(args, source.flag)) {
      values.push(stringFlag(args, source.flag) ?? "");
    }
    if (source.kind === "file" && flagValuePresent(args, source.flag)) {
      const path = requiredStringFlag(args, source.flag, `--${source.flag} requires a file path.`);
      values.push(readFileSync(path, "utf8"));
    }
    if (source.kind === "stdin" && args.flags[source.flag]) {
      values.push(readFileSync(0, "utf8"));
    }
  }

  if (values.length > 1) throw new Error(`edit accepts only one ${label} input source.`);
  return values.length === 0 ? { present: false } : { present: true, value: values[0] };
}

function inputValue(args: ParsedArgs, spec: EditSpec | undefined, specKeys: string[], cliFlag: string): InputValueResult {
  const values: unknown[] = [];
  const specValue = specInputValue(spec, specKeys);
  if (specValue.present) values.push(specValue.value);
  if (flagValuePresent(args, cliFlag)) values.push(stringFlag(args, cliFlag) ?? "");
  if (values.length > 1) throw new Error(`edit accepts only one value for ${specKeys[0]}.`);
  return values.length === 0 ? { present: false } : { present: true, value: values[0] };
}

function optionalIntegerInput(args: ParsedArgs, spec: EditSpec | undefined, cliFlag: string, specKeys: string[]): number | undefined {
  const raw = inputValue(args, spec, specKeys, cliFlag);
  if (!raw.present) return undefined;
  const value = Number(raw.value);
  if (!Number.isInteger(value)) throw new Error(`--${cliFlag} must be an integer.`);
  return value;
}

function booleanInput(args: ParsedArgs, spec: EditSpec | undefined, cliFlag: string, specKeys: string[]): boolean {
  const values: unknown[] = [];
  const specValue = specInputValue(spec, specKeys);
  if (specValue.present) values.push(specValue.value);
  if (args.flags[cliFlag] !== undefined) values.push(args.flags[cliFlag]);
  if (values.length > 1) throw new Error(`edit accepts only one value for ${specKeys[0]}.`);
  if (values.length === 0) return false;
  return values[0] === true || values[0] === "true";
}

function specInputValue(spec: EditSpec | undefined, keys: string[]): InputValueResult {
  if (!spec) return { present: false };
  const values = keys.filter((key) => spec[key] !== undefined).map((key) => spec[key]);
  if (values.length > 1) throw new Error(`edit --spec accepts only one of ${keys.join(", ")}.`);
  return values.length === 0 ? { present: false } : { present: true, value: values[0] };
}

function specString(spec: EditSpec | undefined, keys: string[]): string | undefined {
  const value = specInputValue(spec, keys);
  if (!value.present) return undefined;
  if (typeof value.value !== "string" || value.value.length === 0) throw new Error(`edit --spec ${keys[0]} must be a non-empty string.`);
  return value.value;
}

function loadJsonOrFile(input: string, label: string): unknown {
  const raw = existsSync(input) ? readFileSync(input, "utf8") : input;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const parserError = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON or file not found: ${parserError}`);
  }
}

function optionalIntegerFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer.`);
  return value;
}

function nonnegativeIntegerFlag(args: ParsedArgs, name: string): number | undefined {
  const value = optionalIntegerFlag(args, name);
  if (value !== undefined && value < 0) throw new Error(`--${name} must be a nonnegative integer.`);
  return value;
}

function parseJsonFlag<T>(args: ParsedArgs, name: string): T {
  const raw = stringFlag(args, name);
  if (!raw) throw new Error(`Missing --${name}.`);
  return JSON.parse(raw) as T;
}

type SummaryMode = "files" | "edits";

type ErrorResult = ReturnType<typeof toErrorResult>;

type EditSummaryResult = {
  file: string;
  action: string;
  strategy: string;
  changed: boolean;
  written: boolean;
  diff?: string;
  matches: unknown[];
  guardrails?: unknown[];
  parse_verified: boolean;
  parse_skipped?: boolean;
  parse_skip_reason?: string;
};

function summaryRequested(args: ParsedArgs): boolean {
  return args.flags.summary !== undefined && !args.flags.json;
}

function quietRequested(args: ParsedArgs): boolean {
  return args.flags.quiet === true || args.flags.q === true;
}

function summaryMode(args: ParsedArgs): SummaryMode {
  const raw = args.flags.summary;
  if (raw === undefined || raw === true) return "files";
  const value = String(raw);
  if (value === "files" || value === "edits") return value;
  throw new Error("--summary must be files or edits when a value is provided.");
}

function summaryModeOrDefault(args: ParsedArgs): SummaryMode {
  return args.flags.summary === undefined ? "files" : summaryMode(args);
}

function summarySpecName(args: ParsedArgs): string {
  if (args.flags["from-stdin"] || args.flags.stdin) return "stdin";
  const [spec] = args.positionals;
  return spec ? basename(spec) : "stdin";
}

function formatEditSummary(result: EditSummaryResult): string {
  const matched = result.matches.length;
  const writeText = result.written ? "wrote 1 file" : result.changed ? "no files written (dry-run)" : "no changes";
  const lines = [
    "edit: " + result.file,
    "  " + result.file + "  ok  " + matched + "/" + matched + " " + result.strategy + " " + result.action,
    "result: success - " + matched + "/" + matched + " match" + (matched === 1 ? "" : "es") + ", " + writeText,
  ];
  if (result.diff && result.diff.length > 0) {
    lines.push("next: full diff omitted; use --diff-out <file> to save it or --output detailed to print it");
  }
  if (result.guardrails?.length) lines.push("guardrails: " + result.guardrails.length);
  return lines.join("\n");
}

function formatEditFailureSummary(result: ErrorResult, args: ParsedArgs): string {
  const [filePath] = args.positionals;
  const file = typeof filePath === "string" ? filePath : "<unknown>";
  const lines = [
    "edit: " + file,
    "  " + file + "  FAIL - " + summarizeFailureReason(result),
    "result: failure - " + result.code + ": " + result.error,
  ];
  if (result.suggestions && result.suggestions.length > 0) {
    lines.push("suggestions:");
    lines.push(...result.suggestions.map((hint) => "  - " + hint));
  }
  return lines.join("\n");
}

function formatMultieditSummary(result: MultieditResult, edits: unknown[], spec: string, mode: SummaryMode): string {
  const files = groupMultieditResultsByFile(result.results);
  const width = Math.max(4, ...[...files.keys()].map((file) => file.length));
  const lines = ["spec: " + spec + " (" + edits.length + " edit" + (edits.length === 1 ? "" : "s") + ", " + files.size + " file" + (files.size === 1 ? "" : "s") + ")"];

  if (mode === "edits") {
    for (const step of result.results) {
      const matches = step.matches.length;
      lines.push("  edit[" + step.edit + "] " + step.file.padEnd(width) + "  ok  " + matches + " match" + (matches === 1 ? "" : "es") + "  " + step.strategy + " " + step.action);
    }
  } else {
    for (const [file, steps] of files) {
      lines.push("  " + file.padEnd(width) + "  ok  " + steps.length + "/" + steps.length);
    }
  }

  const written = result.files.filter((file) => file.written).length;
  const changed = result.files.filter((file) => file.changed).length;
  const writeText = written > 0
    ? "wrote " + written + " file" + (written === 1 ? "" : "s")
    : changed > 0
      ? "no files written (dry-run)"
      : "no changes";
  lines.push("result: success - " + result.results.length + "/" + edits.length + " edits matched, " + writeText);
  return lines.join("\n");
}

function formatMultieditFailureSummary(result: ErrorResult, edits: unknown[], spec: string): string {
  const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
  const editIndex = typeof details.edit === "number" ? details.edit : undefined;
  const failedFile = typeof details.file === "string" ? details.file : editIndex === undefined ? undefined : rawEditFile(edits[editIndex]);
  const files = groupRawEditsByFile(edits);
  const width = Math.max(4, ...[...files.keys(), failedFile ?? ""].map((file) => file.length));
  const lines = ["spec: " + spec + " (" + edits.length + " edit" + (edits.length === 1 ? "" : "s") + ", " + files.size + " file" + (files.size === 1 ? "" : "s") + ")"];

  if (files.size === 0 && failedFile) {
    lines.push("  " + failedFile.padEnd(width) + "  FAIL");
  } else {
    for (const [file, indexes] of files) {
      const status = failedFile === file ? "FAIL" : editIndex === undefined || indexes.every((index) => index < editIndex) ? "ok" : "skip";
      const completed = editIndex === undefined ? indexes.length : indexes.filter((index) => index < editIndex).length;
      lines.push("  " + file.padEnd(width) + "  " + status.padEnd(4) + " " + completed + "/" + indexes.length);
    }
  }

  if (editIndex !== undefined) {
    const find = describeRawEditFind(edits[editIndex]);
    lines.push("    edit[" + editIndex + "]" + (find ? " find: " + find : "") + " - " + summarizeFailureReason(result));
  } else if (failedFile) {
    lines.push("    " + failedFile + " - " + summarizeFailureReason(result));
  }
  lines.push("result: failure - " + result.code + ": " + result.error);
  return lines.join("\n");
}

function groupMultieditResultsByFile(results: MultieditResult["results"]): Map<string, MultieditResult["results"]> {
  const files = new Map<string, MultieditResult["results"]>();
  for (const result of results) {
    const list = files.get(result.file) ?? [];
    list.push(result);
    files.set(result.file, list);
  }
  return files;
}

function groupRawEditsByFile(edits: unknown[]): Map<string, number[]> {
  const files = new Map<string, number[]>();
  edits.forEach((edit, index) => {
    const file = rawEditFile(edit) ?? "<unknown>";
    const list = files.get(file) ?? [];
    list.push(index);
    files.set(file, list);
  });
  return files;
}

function rawEditFile(edit: unknown): string | undefined {
  return edit && typeof edit === "object" && !Array.isArray(edit) && typeof (edit as Record<string, unknown>).file === "string"
    ? (edit as Record<string, string>).file
    : undefined;
}

function describeRawEditFind(edit: unknown): string | null {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) return null;
  const record = edit as Record<string, unknown>;
  const value = record.find ?? record.findExact ?? record["find-exact"] ?? record.findFuzzy ?? record["find-fuzzy"] ?? record.findRegex ?? record["find-regex"] ?? record.findLines ?? record["find-lines"];
  if (value === undefined) return null;
  return JSON.stringify(truncateSummary(String(value), 60));
}

function summarizeFailureReason(result: ErrorResult): string {
  const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
  const cause = details.cause && typeof details.cause === "object" ? details.cause as Record<string, unknown> : details;
  if (result.code === "MATCH_NONE") return "no match";
  if (result.code === "MATCH_COUNT_MISMATCH") {
    const expected = cause.expected_count;
    const actual = cause.actual_count;
    return "count mismatch" + (expected !== undefined && actual !== undefined ? " (expected " + expected + ", got " + actual + ")" : "");
  }
  if (result.code === "MATCH_NOT_UNIQUE") {
    const matches = Array.isArray(cause.matches) ? cause.matches.length : undefined;
    const fuzzy = cause.fuzzy_strategy ? "fuzzy " : "";
    return fuzzy + (matches ?? "multiple") + " candidates";
  }
  if (result.code === "MATCH_FUZZY_ONLY") return "fuzzy-only match available";
  if (result.code === "PARSE_BROKEN_AFTER_EDIT") return "parse verification failed";
  return result.error;
}

function truncateSummary(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? compact.slice(0, Math.max(0, max - 3)) + "..." : compact;
}

function formatPlanInspect(result: InspectPlanResult): string {
  const target = result.files.find((file) => file.role === "target");
  return [
    result.summary,
    "source: " + formatPlanFileStatus(result.files.find((file) => file.role === "source")),
    ...(target ? ["target: " + formatPlanFileStatus(target)] : []),
    "steps:",
    ...result.steps.map((step) => "  - " + step.id + " [" + step.risk + "] " + step.kind + (step.file ? " " + step.file : "")),
  ].join("\n");
}

function formatPlanFileStatus(file: InspectPlanResult["files"][number] | undefined): string {
  if (!file) return "missing";
  if (!file.exists) return file.file + " (missing)";
  return file.file + (file.stale ? " (stale)" : " (ready)");
}

function formatErrorResult(result: ErrorResult): unknown {
  if (!currentArgs) return result;
  try {
    return formatAgentResult(result, outputOptions(currentArgs));
  } catch {
    // Formatting errors should not hide the original command failure.
    return result;
  }
}

function printJson(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function output(args: ParsedArgs, json: unknown, text: string): void {
  writeDiffOut(args, json);
  if (quietRequested(args)) return;
  if (outputMode(args) === "compact") {
    process.stdout.write(JSON.stringify(formatAgentResult(json, outputOptions(args)), null, 2) + "\n");
    return;
  }
  if (args.flags.json) process.stdout.write(JSON.stringify(json, null, 2) + "\n");
  else process.stdout.write(text + "\n");
}

function outputMode(args: ParsedArgs): OutputMode {
  const explicit = parseOutputMode(stringFlag(args, "output") ?? process.env.TEDIT_OUTPUT, "--output/TEDIT_OUTPUT");
  if (explicit) return explicit;
  if (args.flags.json) return "detailed";
  const configured = loadQualityConfig(outputConfigSearchPath(args)).defaultOutput;
  if (configured === "compact" || configured === "detailed") return configured;
  return process.stdout.isTTY ? "detailed" : "compact";
}

function outputConfigSearchPath(args: ParsedArgs): string {
  return args.positionals[0] ?? process.cwd();
}

function outputOptions(args: ParsedArgs): OutputOptions {
  const configOptions = outputOptionsFromConfig(outputConfigSearchPath(args));
  return {
    ...configOptions,
    mode: outputMode(args),
    includeDiffs: booleanFlag(args, "include-diffs") || booleanFlag(args, "includeDiffs"),
    includeDetails: booleanFlag(args, "include-details") || booleanFlag(args, "includeDetails"),
    diffMode: parseDiffMode(stringFlag(args, "diff-mode") ?? stringFlag(args, "diffMode"), "--diff-mode") ?? configOptions.diffMode,
    inlineDiffMaxBytes: positiveIntegerFlag(args, "inline-diff-max-bytes") ?? positiveIntegerFlag(args, "inlineDiffMaxBytes") ?? configOptions.inlineDiffMaxBytes,
    inlineDiffMaxHunks: positiveIntegerFlag(args, "inline-diff-max-hunks") ?? positiveIntegerFlag(args, "inlineDiffMaxHunks") ?? configOptions.inlineDiffMaxHunks,
    diffArtifactDir: stringFlag(args, "diff-artifact-dir") ?? stringFlag(args, "diffArtifactDir") ?? configOptions.diffArtifactDir,
    diffArtifacts: optionalBooleanFlag(args, "diff-artifacts") ?? optionalBooleanFlag(args, "diffArtifacts") ?? configOptions.diffArtifacts,
  };
}

function positiveIntegerFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

function optionalBooleanFlag(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}

function booleanFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags[name];
  return value === true || value === "true";
}

function writeDiffOut(args: ParsedArgs, result: unknown): void {
  const file = stringFlag(args, "diff-out");
  if (!file) return;
  writeFileSync(file, collectDiffs(result).join("\n"));
}

function collectDiffs(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectDiffs);
  const record = value as Record<string, unknown>;
  const diffs: string[] = [];
  if (typeof record.diff === "string" && record.diff.length > 0) diffs.push(record.diff);
  if (record.diffs && typeof record.diffs === "object") {
    for (const diff of Object.values(record.diffs as Record<string, unknown>)) {
      if (typeof diff === "string" && diff.length > 0) diffs.push(diff);
    }
  }
  if (Array.isArray(record.files)) diffs.push(...record.files.flatMap(collectDiffs));
  return diffs;
}

function withWarnings(text: string, warnings: QualityWarning[]): string {
  const formatted = formatQualityWarnings(warnings);
  return formatted ? `${text}\n${formatted}` : text;
}

function withWritePolicyNotes(text: string, policy: WritePolicy, backup?: BackupResult): string {
  const notes = formatWritePolicyNotes(policy, backup);
  return notes ? `${text}\n${notes}` : text;
}

function writeFlags(args: ParsedArgs): { write: boolean; dryRun: boolean; backup: boolean; noBackup: boolean } {
  return {
    write: Boolean(args.flags.write),
    dryRun: Boolean(args.flags["dry-run"]),
    backup: Boolean(args.flags.backup),
    noBackup: Boolean(args.flags["no-backup"]),
  };
}

function formatMatches(matches: unknown[]): string {
  if (matches.length === 0) return "No matches";
  return matches.map((match) => {
    const item = match as { id: string; name: string; loc?: { start: { line: number } }; preview: string };
    const loc = item.loc ? `:${item.loc.start.line}` : "";
    return `${item.id} ${item.name}${loc} ${item.preview}`;
  }).join("\n");
}

function formatInspectedLines(lines: unknown[]): string {
  return lines.map((value) => {
    const item = value as { number: number; text: string };
    return `${String(item.number).padStart(4, " ")}: ${item.text}`;
  }).join("\n");
}

function formatSearchResults(results: unknown[]): string {
  if (results.length === 0) return "No matches";
  return results.map((value) => {
    const item = value as {
      id: string;
      path: string;
      match: string;
      range: { line: number; column: number };
      preview: string;
      context?: { lines?: Array<{ number: number; text: string }> };
    };
    const header = `${item.id} ${item.path}:${item.range.line}:${item.range.column} ${JSON.stringify(item.match)} ${item.preview}`;
    if (!item.context?.lines?.length) return header;
    return [header, ...item.context.lines.map((line) => `  ${String(line.number).padStart(4, " ")}: ${line.text}`)].join("\n");
  }).join("\n");
}

function formatHistoryTrace(result: unknown): string {
  const record = result as { target?: { type?: string; path?: string; lines?: string; contains?: string; regex?: string }; latest?: { commit?: string; date?: string; subject?: string }; commits?: unknown[]; blame?: unknown[] };
  const target = record.target ?? {};
  const targetLabel = [target.path, target.lines ? `lines ${target.lines}` : target.contains ? `contains ${JSON.stringify(target.contains)}` : target.regex ? `regex ${JSON.stringify(target.regex)}` : target.type].filter(Boolean).join(" ");
  const lines = [`history: ${targetLabel}`];
  if (record.latest?.commit) {
    lines.push(`latest: ${record.latest.commit.slice(0, 12)} ${record.latest.date ?? ""} ${record.latest.subject ?? ""}`.trim());
  }
  lines.push(`commits: ${Array.isArray(record.commits) ? record.commits.length : 0}`);
  if (Array.isArray(record.blame) && record.blame.length > 0) lines.push(`blame: ${record.blame.length} commit(s)`);
  return lines.join("\n");
}

function formatAstStrings(strings: unknown[]): string {
  if (strings.length === 0) return "No strings";
  return strings.map((value) => {
    const item = value as { id: string; kind: string; value: string; range: { line: number; column: number }; context: string; excluded?: boolean; excludeReason?: string };
    const excluded = item.excluded ? ` excluded=${item.excludeReason ?? "true"}` : "";
    return `${item.id} ${item.kind}:${item.range.line}:${item.range.column} ${JSON.stringify(item.value)} (${item.context})${excluded}`;
  }).join("\n");
}

function formatAstMatches(matches: unknown[]): string {
  if (matches.length === 0) return "No AST matches";
  return matches.map((value) => {
    const item = value as { id: string; type: string; value?: unknown; range: { line: number; column: number }; preview: string; editable?: boolean };
    const valueText = item.value === undefined ? "" : ` value=${JSON.stringify(item.value)}`;
    const editable = item.editable ? " editable" : "";
    return `${item.id} ${item.type}:${item.range.line}:${item.range.column}${valueText}${editable} ${item.preview}`;
  }).join("\n");
}

function requirePositionals(args: ParsedArgs, count: number, usage: string): string[] {
  if (args.positionals.length < count) throw new Error(`Usage: tedit ${usage}`);
  return args.positionals;
}

function requireChainArgs(args: string[]): string[] {
  if (args.length === 0) throw new Error("Usage: tedit chain <file> <action> [args...] [:: <action> ...] or --from-file/--from-stdin");
  return args;
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined || value === false) return undefined;
  if (Array.isArray(value)) return value.at(-1);
  return String(value);
}

function stringFlags(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  if (value === undefined || value === false) return [];
  if (Array.isArray(value)) return value;
  if (value === true) return [];
  return [String(value)];
}

function flagValuePresent(args: ParsedArgs, name: string): boolean {
  const value = args.flags[name];
  return value !== undefined && value !== false && value !== true;
}

function requiredStringFlag(args: ParsedArgs, name: string, message: string): string {
  const value = stringFlag(args, name);
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === "chain") return parseChainCommandArgs(rest);
  if (command === "chain-workspace" || command === "wchain") return parseChainCommandArgs(rest, command);

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-q") {
      addFlag(flags, "quiet", true);
      continue;
    }
    if (arg === "-h") {
      addFlag(flags, "help", true);
      continue;
    }
    if (arg === "-v") {
      addFlag(flags, "version", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq >= 0) {
      addFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }

    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      addFlag(flags, name, next);
      i++;
    } else {
      addFlag(flags, name, true);
    }
  }

  return { command, positionals, flags };
}

function parseChainCommandArgs(argv: string[], command = "chain"): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const globalFlagsWithValue = new Set(["from-file", "params"]);
  const globalBooleanFlags = new Set(["from-stdin", "write", "dry-run", "json", "help", "quiet", "version"]);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-q") {
      addFlag(flags, "quiet", true);
      continue;
    }
    if (arg === "-h") {
      addFlag(flags, "help", true);
      continue;
    }
    if (arg === "-v") {
      addFlag(flags, "version", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (globalFlagsWithValue.has(name)) {
      if (eq >= 0) {
        addFlag(flags, name, arg.slice(eq + 1));
      } else {
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value.`);
        addFlag(flags, name, next);
        index++;
      }
      continue;
    }
    if (globalBooleanFlags.has(name)) {
      addFlag(flags, name, eq >= 0 ? arg.slice(eq + 1) : true);
      continue;
    }

    positionals.push(arg);
  }

  return { command, positionals, flags };
}

function addFlag(flags: ParsedArgs["flags"], name: string, value: string | boolean): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[name] = [String(existing), String(value)];
  }
}

function printVersion(): void {
  process.stdout.write("tedit " + packageVersion() + "\n");
}

function commandPath(command: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) return undefined;
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", [command], { encoding: "utf8", timeout: 2000 });
    if (result.status !== 0) return undefined;
    const paths = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return paths.find((path) => /\.(?:cmd|exe|bat)$/i.test(path)) ?? paths.find((path) => !/\.ps1$/i.test(path)) ?? paths[0];
  }
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8", timeout: 2000 });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function commandExists(command: string): boolean {
  return commandPath(command) !== undefined;
}

function spawnCommand(command: string, args: string[], options: Parameters<typeof spawnSync>[2]) {
  const executable = commandPath(command) ?? command;
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", windowsCommandLine([executable, ...args])], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(executable, args, options);
}

function windowsCommandLine(args: string[]): string {
  const [command, ...rest] = args;
  return [quoteWindowsCommand(command ?? ""), ...rest.map(quoteWindowsArg)].join(" ");
}

function quoteWindowsCommand(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

function quoteWindowsArg(arg: string): string {
  return arg === "" || /\s/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function latestNpmVersion(required: boolean): string | undefined {
  if (process.env.TEDIT_TEST_LATEST_VERSION) return process.env.TEDIT_TEST_LATEST_VERSION;
  const result = spawnCommand("npm", ["view", "tedit", "version"], { encoding: "utf8", timeout: 5000 });
  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "";
  if (result.status === 0) return stdout.trim();
  if (required) throw new Error("Could not check npm latest version.");
  return undefined;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function promptSetupTargets(): Promise<SetupTarget[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      process.stdout.write("Select MCP host:\n  1) claude\n  2) codex\n  3) both (claude + codex)\n");
      const answer = (await rl.question("Host [3]: ")).trim().toLowerCase();
      if (answer === "" || answer === "3" || answer === "both" || answer === "all") return ["claude", "codex"];
      if (answer === "1" || answer === "claude") return ["claude"];
      if (answer === "2" || answer === "codex") return ["codex"];
      process.stdout.write("Please enter 1, 2, 3, claude, codex, or both.\n");
    }
  } finally {
    rl.close();
  }
}

async function promptSetupScope(target: "mcp" | SetupTarget): Promise<SetupScope> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question(`MCP setup scope for ${target} (user/project) [user]: `)).trim().toLowerCase();
      if (answer === "" || answer === "u" || answer === "user") return "user";
      if (answer === "p" || answer === "project") return "project";
      process.stdout.write("Please enter user or project.\n");
    }
  } finally {
    rl.close();
  }
}

function printHelp(command?: string): void {
  if (command) {
    const text = shortHelp(command);
    if (!text) throw new Error("Unknown help topic: " + command);
    process.stdout.write(text + "\n");
    return;
  }
  process.stdout.write(`tedit

Usage:
  tedit edit <file> --find <text> --replace <text> [--replace-all] [--expect-count N] [--dry-run|--write]
  tedit edit <file> --find <text> --insert-before <text> [--dry-run|--write]
  tedit edit <file> --find <text> --insert-after <text> [--dry-run|--write]
  tedit edit <file> --find <text> --delete [--dry-run|--write]
  tedit edit <file> --find-fuzzy <text> --replace <text> [--dry-run|--write]
  tedit edit <file> --find-anchor-after <text> --find <text> --replace <text> [--dry-run|--write]
  tedit edit <file> --find-regex <pattern> [--flags <flags>] --replace <text> [--replace-all] [--dry-run|--write]
  tedit edit <file> --find-lines N:M --delete [--dry-run|--write]
  tedit edit <file> --find-file <file> --replace-file <file> [--dry-run|--write]
  tedit edit <file> --find <text> --replace-stdin [--dry-run|--write]
  tedit edit <file> --find-stdin --replace <text> [--dry-run|--write]
  tedit edit <file> --spec <edit-json-or-file> [--summary|--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit multiedit <edits-json> [--summary[=files|edits]|--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit multiedit --from-stdin [--summary[=files|edits]|--quiet] [--diff-out <file>] [--dry-run|--write] < edits.json
  tedit verify <edits-json> [--summary[=files|edits]|--quiet] [--diff-out <file>]
  tedit verify --from-stdin [--summary[=files|edits]|--quiet] [--diff-out <file>] < edits.json
  tedit verify-file <file...> [--json]
  tedit patch <patch-file> [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit patch --from-stdin [--quiet] [--diff-out <file>] [--dry-run|--write] < change.patch
  tedit patch --stdin [--quiet] [--diff-out <file>] [--dry-run|--write] < change.patch
  tedit actions [file] [--json]
  tedit setup mcp [--target claude|codex|both] [--scope user|project] [--dry-run]
  tedit setup codex|claude|print [--scope user|project] [--dry-run]
  tedit doctor [--skip-update] [--json]
  tedit update [--check|--yes]
  tedit inspect-range <file> --lines N:M [--context N] [--json]
  tedit search-text <query> [path...] [--regex] [--glob <glob>] [--context N] [--multiedit-spec --replace <text>] [--max-results N] [--json]
  tedit history-trace <file> [--lines N:M|--contains <text>|--regex <pattern>] [--limit N] [--json]
  tedit scan-strings <file> [--contains <text>] [--include-excluded] [--json]
  tedit ast-select <file> <selector> [--json]
  tedit ast-edit <file> [selector] --replace <text> [--string text|--contains text|--jsx-text text|--jsx-attr name|--object-key key|--call callee] [--dry-run|--write]
  tedit ts-select <file> [fn:name|class:Name|method:Owner.name|prop:name|var:name] [--json]
  tedit ts-edit <file> <selector> --body <body>|--insert-before <code>|--insert-after <code> [--dry-run|--write]
  tedit ts-move <file> <target-selector> (--before <selector>|--after <selector>) [--confirm-trivia] [--dry-run|--write]
  tedit analyze-state <file> [--json]
  tedit refactor-state <file> [--cluster <name>] [--to <hook-file> --name <hookName>] [--external-deps fail|params] [--plan-out <plan-json>|--dry-run|--write]
  tedit find <file> <selector> [--json]
  tedit inspect <file> [selector] [--id <id>] [--json]
  tedit append <file> <selector> --element <json> [--dry-run|--write]
  tedit prepend <file> <selector> --element <json> [--dry-run|--write]
  tedit wrap <file> <selector> --with <tag-or-json> [--dry-run|--write]
  tedit unwrap <file> <selector> [--dry-run|--write]
  tedit remove <file> <selector> [--dry-run|--write]
  tedit rename <file> <selector> --to <name> [--dry-run|--write]
  tedit insertComment <file> <selector> <text> [--position inside-start|inside-end|before|after] [--write]
  tedit text set <file> <selector> --value <text> [--dry-run|--write]
  tedit text set <file> <selector> --expr <expr> [--dry-run|--write]
  tedit text replace <file> <selector> --match-text <text> --with-text <text> [--dry-run|--write]
  tedit text replace <file> <selector> --match-expr <expr> --with-expr <expr> [--dry-run|--write]
  tedit prop set <file> <selector> <name> [value] [--expr <code>] [--dry-run|--write]
  tedit prop remove <file> <selector> <name> [--dry-run|--write]
  tedit class add <file> <selector> <class...> [--dry-run|--write]
  tedit class remove <file> <selector> <class...> [--dry-run|--write]
  tedit class replace <file> <selector> <from> <to> [--dry-run|--write]
  tedit imports add <file> --from <source> --named A,B [--default Name] [--dry-run|--write]
  tedit imports remove <file> --from <source> --named A,B [--dry-run|--write]
  tedit imports rename <file> --from <source> --name Old --to New [--dry-run|--write]
  tedit imports move <file> --from <source> --to <source> --named A,B [--dry-run|--write]
  tedit expr replace <file> <selector> --code <expr> [--dry-run|--write]
  tedit expr wrap <file> <selector> --code 'cond ? $expr : null' [--dry-run|--write]
  tedit expr unwrap <file> <selector> [--dry-run|--write]
  tedit expr toTernary <file> <selector> [--alternate <expr>] [--dry-run|--write]
  tedit expr toShortCircuit <file> <selector> [--dry-run|--write]
  tedit extract <file> <selector> --to <new-file> --name <ComponentName> [--slot '<selector>.children[=prop]'|--depth N --auto-slot] [--typecheck] [--helpers ask|move|share|as-prop] [--helper name=move|share|leave|as-prop] [--max-props N|--accept-large-props] [--export named|default] [--overwrite] [--plan-out <plan-json>|--dry-run|--write]
  tedit apply-plan <plan-json> [--only <step-id>] [--skip <step-id>] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit plan inspect <plan-json> [--json]
  tedit create <file> --source <source> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit create <file> --from-file <source-file> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit create <file> --from-stdin [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit write <file> --source <source> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit write <file> --from-file <source-file> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit write <file> --from-stdin [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit scaffold <file> --spec <json-or-file> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit scaffold <file> --directives "use client" --imports "@/lib/utils:cn" --export "function:Button(props)" --body 'button.children="Save"' [--write]
  tedit new <template> <file> --param name=Button [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit templates [--cwd <dir>] [--json]
  tedit flow <file> <flow-json> [--params <json-or-file>] [--dry-run|--write]
  tedit workspace-flow <flow-json> [--params <json-or-file>] [--dry-run|--write]
  tedit chain <file> find <selector> as body :: append '@body' PageHead :: append '$ret.id' LeftPanel [--write]
  tedit chain <file> --from-file <chain-file> [--dry-run|--write]
  tedit chain <file> --from-stdin [--dry-run|--write]
  tedit chain-workspace extract src/Page.tsx Card --to src/PageCard.tsx --name PageCard :: in src/PageCard.tsx prop.set Card data-extracted true [--write]
  tedit chain-workspace --from-file <workspace-chain-file> [--dry-run|--write]
  tedit chain-workspace --from-stdin [--dry-run|--write]
  tedit rules [--json]
  tedit backups list [--root <dir>]
  tedit backups restore <id> [--root <dir>] [--dry-run|--write]
  tedit backups clean --older-than <duration> [--root <dir>] [--dry-run|--write]

Mutation commands use git-aware default write mode. Pass --dry-run or --write to be explicit.
Compact output uses --diff-mode off|stats|auto|full. Default auto inlines small diffs and saves large write diffs under .tedit-cache/diffs; stats keeps counts only.
Use tedit help <command> for short command-specific help.
`);
}

function shortHelp(command: string): string | null {
  switch (command) {
    case "edit":
      return [
        "tedit edit",
        "Usage:",
        "  tedit edit <file> --find <text> --replace <text> [--summary|--quiet] [--diff-out <file>] [--dry-run|--write]",
        "  tedit edit <file> --spec <edit-json-or-file> [--summary|--quiet] [--dry-run|--write]",
        "",
        "Use --find-file/--replace-file or --find-stdin/--replace-stdin for multiline input.",
      ].join("\n");
    case "multiedit":
      return [
        "tedit multiedit",
        "Usage:",
        "  tedit multiedit <edits-json> [--summary[=files|edits]|--quiet] [--diff-out <file>] [--dry-run|--write]",
        "  tedit multiedit --from-stdin [--summary[=files|edits]|--quiet] < edits.json",
        "",
        "Applies many universal base edits atomically. --summary omits full diffs and file payloads.",
      ].join("\n");
    case "verify":
      return [
        "tedit verify",
        "Usage:",
        "  tedit verify <edits-json> [--summary[=files|edits]|--quiet] [--diff-out <file>]",
        "  tedit verify --from-stdin [--summary[=files|edits]|--quiet] < edits.json",
        "",
        "Runs a multiedit spec as an explicit dry-run and prints terse summary output by default.",
      ].join("\n");
    case "verify-file":
      return [
        "tedit verify-file",
        "Usage:",
        "  tedit verify-file <file...> [--json]",
        "",
        "Runs tedit parse verification for one or more current files without planning an edit.",
      ].join("\n");
    case "patch":
      return [
        "tedit patch",
        "Usage:",
        "  tedit patch <patch-file> [--quiet] [--diff-out <file>] [--dry-run|--write]",
        "  tedit patch --stdin [--quiet] [--diff-out <file>] < change.patch",
        "",
        "Accepts unified diffs and Codex apply-patch envelopes.",
      ].join("\n");
    case "extract":
      return "tedit extract\nUsage:\n  tedit extract <file> <selector> --to <new-file> --name <ComponentName> [--typecheck] [--helpers ask|move|share|as-prop] [--plan-out <plan-json>|--dry-run|--write]";
    case "apply-plan":
      return "tedit apply-plan\nUsage:\n  tedit apply-plan <plan-json> [--only <step-id>] [--skip <step-id>] [--quiet] [--diff-out <file>] [--dry-run|--write]\n\nValidates and applies a tedit refactor plan. Defaults to dry-run unless --write is passed.";
    case "plan":
      return "tedit plan\nUsage:\n  tedit plan inspect <plan-json> [--json]\n\nSummarizes a saved tedit refactor plan before apply-plan.";
    case "refactor-state":
      return "tedit refactor-state\nUsage:\n  tedit refactor-state <file> [--cluster <name>] [--to <hook-file> --name <hookName>] [--external-deps fail|params] [--plan-out <plan-json>|--dry-run|--write]";
    case "actions":
      return "tedit actions\nUsage:\n  tedit actions [file] [--json]\n\nLists universal base actions and file-specific language actions.";
    case "setup":
      return "tedit setup\nUsage:\n  tedit setup mcp [--target claude|codex|both] [--scope user|project] [--dry-run]\n  tedit setup codex|claude [--scope user|project] [--dry-run]\n  tedit setup print\n\nInteractive MCP setup asks for host first (claude, codex, or both), then user/project scope. Codex currently supports user scope only.";
    case "doctor":
      return "tedit doctor\nUsage:\n  tedit doctor [--skip-update] [--json]\n\nChecks tedit, tedit-mcp, actions, and available npm updates.";
    case "update":
      return "tedit update\nUsage:\n  tedit update [--check|--yes]\n\nChecks npm for a newer tedit and installs it only after confirmation or --yes.";
    case "inspect-range":
    case "inspect_range":
      return "tedit inspect-range\nUsage:\n  tedit inspect-range <file> --lines N:M [--context N] [--json]\n\nShows line context, byte range, parser status, and edit-ready suggestions.";
    case "search-text":
    case "search_text":
      return "tedit search-text\nUsage:\n  tedit search-text <query> [path...] [--regex] [--glob <glob>] [--context N] [--multiedit-spec --replace <text>] [--max-results N] [--json]\n\nSearches text and returns edit-ready candidates with optional context, multiedit specs, and inspect/edit follow-ups.\n\nGlob supports *, **, ?, and comma braces such as **/*.{ts,tsx}; spaces around brace alternatives are ignored.";
    case "history-trace":
    case "history_trace":
      return "tedit history-trace\nUsage:\n  tedit history-trace <file> [--lines N:M|--contains <text>|--regex <pattern>] [--limit N] [--json]\n\nTraces git history with blame/log -L for lines or log -S/-G for text.";
    case "scan-strings":
    case "scan_strings":
      return "tedit scan-strings\nUsage:\n  tedit scan-strings <file> [--contains <text>] [--include-excluded] [--json]\n\nScans JS/TS/JSX AST string candidates for hardcoded user-facing text.";
    case "ast-select":
    case "ast_select":
      return "tedit ast-select\nUsage:\n  tedit ast-select <file> <selector> [--json]\n\nFinds JS/TS/JSX AST nodes using a small selector language, e.g. StringLiteral[value*=\"삭제\"].";
    case "ast-edit":
    case "ast_edit":
      return "tedit ast-edit\nUsage:\n  tedit ast-edit <file> [selector] --replace <text> [--string text|--contains text|--jsx-text text|--jsx-attr name|--object-key key|--call callee] [--dry-run|--write]\n\nSafely replaces one editable AST string target matched by ast-select or a shortcut.";
    case "ts-select":
    case "ts_select":
      return "tedit ts-select\nUsage:\n  tedit ts-select <file> [fn:name|class:Name|method:Owner.name|prop:name|var:name] [--json]\n\nFinds named TS/JS declarations with source ranges and body-replace capability flags.";
    case "ts-edit":
    case "ts_edit":
      return "tedit ts-edit\nUsage:\n  tedit ts-edit <file> <selector> --body <body> [--dry-run|--write]\n  tedit ts-edit <file> <selector> --insert-before <code> [--dry-run|--write]\n  tedit ts-edit <file> <selector> --insert-after <code> [--dry-run|--write]\n\nTargets named declarations and replaces only tool-owned block bodies or inserts declarations around them.";
    case "ts-move":
    case "ts_move":
      return "tedit ts-move\nUsage:\n  tedit ts-move <file> <target-selector> (--before <selector>|--after <selector>) [--take id[,id]] [--drop id[,id]] [--confirm-trivia] [--dry-run|--write]\n\nMoves a named declaration as a source-range cut/paste with carried-trivia hints. Writes require --confirm-trivia.";
    case "analyze-state":
      return "tedit analyze-state\nUsage:\n  tedit analyze-state <file> [--json]\n\nReports useState clusters, handler usage, and refactor guidance.";
    case "find":
      return "tedit find\nUsage:\n  tedit find <file> <selector> [--json]\n\nFinds JSX/TSX nodes using tedit's CSS-like selector language.";
    case "inspect":
      return "tedit inspect\nUsage:\n  tedit inspect <file> [selector] [--id <id>] [--json]\n\nPrints structural details for a matched node.";
    case "append":
    case "prepend":
      return "tedit " + command + "\nUsage:\n  tedit " + command + " <file> <selector> --element <json-or-shorthand> [--dry-run|--write]";
    case "wrap":
      return "tedit wrap\nUsage:\n  tedit wrap <file> <selector> --with <tag-or-json> [--dry-run|--write]";
    case "unwrap":
    case "remove":
      return "tedit " + command + "\nUsage:\n  tedit " + command + " <file> <selector> [--dry-run|--write]";
    case "rename":
      return "tedit rename\nUsage:\n  tedit rename <file> <selector> --to <name> [--dry-run|--write]";
    case "insertComment":
      return "tedit insertComment\nUsage:\n  tedit insertComment <file> <selector> <text> [--position inside-start|inside-end|before|after] [--write]";
    case "text":
      return "tedit text\nUsage:\n  tedit text set <file> <selector> --value <text> [--dry-run|--write]\n  tedit text set <file> <selector> --expr <expr> [--dry-run|--write]\n  tedit text replace <file> <selector> --match-text <text> --with-text <text> [--dry-run|--write]";
    case "prop":
      return "tedit prop\nUsage:\n  tedit prop set <file> <selector> <name> [value] [--expr <code>] [--dry-run|--write]\n  tedit prop remove <file> <selector> <name> [--dry-run|--write]";
    case "imports":
      return "tedit imports\nUsage:\n  tedit imports add <file> --from <source> --named A,B [--default Name] [--dry-run|--write]\n  tedit imports remove <file> --from <source> --named A,B [--dry-run|--write]\n  tedit imports rename <file> --from <source> --name Old --to New [--dry-run|--write]\n  tedit imports move <file> --from <source> --to <source> --named A,B [--dry-run|--write]";
    case "expr":
      return "tedit expr\nUsage:\n  tedit expr replace <file> <selector> --code <expr> [--dry-run|--write]\n  tedit expr wrap <file> <selector> --code 'cond ? $expr : null' [--dry-run|--write]\n  tedit expr unwrap <file> <selector> [--dry-run|--write]\n  tedit expr toTernary <file> <selector> [--alternate <expr>] [--dry-run|--write]\n  tedit expr toShortCircuit <file> <selector> [--dry-run|--write]";
    case "create":
    case "write":
      return "tedit " + command + "\nUsage:\n  tedit " + command + " <file> --source <source> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]\n  tedit " + command + " <file> --from-file <source-file> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]\n  tedit " + command + " <file> --from-stdin [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]";
    case "scaffold":
      return "tedit scaffold\nUsage:\n  tedit scaffold <file> --spec <json-or-file> [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]\n  tedit scaffold <file> --directives \"use client\" --imports \"@/lib/utils:cn\" --export \"function:Button(props)\" --body 'button.children=\"Save\"' [--write]";
    case "new":
      return "tedit new\nUsage:\n  tedit new <template> <file> --param name=Button [--overwrite] [--quiet] [--diff-out <file>] [--dry-run|--write]";
    case "templates":
      return "tedit templates\nUsage:\n  tedit templates [--cwd <dir>] [--json]\n\nLists built-in, global, and project-local .tedit/templates.";
    case "flow":
      return "tedit flow\nUsage:\n  tedit flow <file> <flow-json> [--params <json-or-file>] [--dry-run|--write]";
    case "workspace-flow":
    case "wflow":
      return "tedit workspace-flow\nUsage:\n  tedit workspace-flow <flow-json> [--params <json-or-file>] [--dry-run|--write]";
    case "rules":
      return "tedit rules\nUsage:\n  tedit rules [--json]\n\nLists registered language rules.";
    case "backups":
      return "tedit backups\nUsage:\n  tedit backups list [--root <dir>]\n  tedit backups restore <id> [--root <dir>] [--dry-run|--write]\n  tedit backups clean --older-than <duration> [--root <dir>] [--dry-run|--write]";
    case "chain":
      return "tedit chain\nUsage:\n  tedit chain <file> <step> :: <step> [--write]\n  tedit chain <file> --from-file <chain-file> [--dry-run|--write]";
    case "chain-workspace":
    case "wchain":
      return "tedit chain-workspace\nUsage:\n  tedit chain-workspace <workspace-steps> [--write]\n  tedit chain-workspace --from-file <workspace-chain-file> [--dry-run|--write]";
    default:
      return null;
  }
}
