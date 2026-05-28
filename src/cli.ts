#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  BASE_ACTIONS,
  parseLineRange,
  parseVerificationFields,
  planBaseEdit,
  verifyParseForFile,
  type BaseEditMutation,
  type BaseFindStrategy,
} from "./base-edit.js";
import { chainToFlow, fileChainToWorkspaceFlow, parseChainSegments, parseChainText, workspaceChainToFlow } from "./chain.js";
import type { ImportEditSpec, TextMatchSpec, TextValueSpec, TreeNodeSpec, ValueSpec } from "./core/document.js";
import { getOptionalAdapterForFile, listRules, openDocumentForFile } from "./core/registry.js";
import { unifiedDiff } from "./diff.js";
import { toErrorResult } from "./errors.js";
import { formatAgentResult, parseOutputMode, type OutputMode, type OutputOptions } from "./output.js";
import { planExtract, type HelperPolicy } from "./extract.js";
import { parseMultieditInput, runMultiedit, runMultieditInput, type MultieditResult } from "./multiedit.js";
import { runPatchInput } from "./patch.js";
import { runRefactorState } from "./refactor-state.js";import { applyRefactorPlan, buildExtractComponentPlan, inspectRefactorPlan, writePlanFile, type InspectPlanResult } from "./refactor-plan.js";
import { analyzeState, fileLengthWarnings, formatFileLengthWarnings, type FileLengthWarning } from "./quality.js";
import { loadParams, parseFlowInput, runFlow } from "./flow.js";
import {
  buildScaffoldSource,
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

let currentArgs: ParsedArgs | undefined;

main().catch((error) => {
  const result = toErrorResult(error);
  process.stderr.write(JSON.stringify(formatErrorResult(result), null, 2) + "\n");
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
  const warnings = fileLengthWarnings(filePath, source, plan.nextSource);
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
  const result = runRefactorState(filePath, {
    cluster: stringFlag(args, "cluster"),
    to: stringFlag(args, "to"),
    name: stringFlag(args, "name"),
    externalDeps: externalDeps as "fail" | "params",
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
    ...fileLengthWarnings(filePath, plan.source, plan.nextSource),
    ...fileLengthWarnings(plan.result.to, previousNewSource, plan.newSource),
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
      { file: filePath, existed: true, changed: plan.source !== plan.nextSource, written: shouldWrite, warnings: fileLengthWarnings(filePath, plan.source, plan.nextSource), write_policy: writePolicyReport(sourcePolicy, sourceBackup), ...(sourceBackup.path ? { backup: sourceBackup.path } : {}), ...(sourceDiff ? { diff: sourceDiff } : {}) },
      { file: plan.result.to, existed: targetExisted, changed: previousNewSource !== plan.newSource, written: shouldWrite, warnings: fileLengthWarnings(plan.result.to, previousNewSource, plan.newSource), write_policy: writePolicyReport(targetPolicy, targetBackup), ...(targetBackup.path ? { backup: targetBackup.path } : {}), ...(newFileDiff ? { diff: newFileDiff } : {}) },
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
  const spec = loadTemplateSpec(templateName, params);
  const source = buildScaffoldSource(spec);
  finishCreation(args, filePath, source, { kind: "new", template: templateName, spec });
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
  const [filePath] = requirePositionals(args, 1, "verify-file <file>");
  const verification = verifyParseForFile(filePath, readFileSync(filePath, "utf8"));
  const result = {
    success: true,
    file: filePath,
    ...parseVerificationFields(verification),
  };
  output(args, result, verification.verified
    ? `${filePath}: parse verified (${verification.parser})`
    : `${filePath}: no parser registered`);
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
  const warnings = fileLengthWarnings(doc.filePath, doc.source, next);
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
  const warnings = fileLengthWarnings(filePath, previous, source);
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
  matches: unknown[];
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
  return [
    "edit: " + result.file,
    "  " + result.file + "  ok  " + matched + "/" + matched + " " + result.strategy + " " + result.action,
    "result: success - " + matched + "/" + matched + " match" + (matched === 1 ? "" : "es") + ", " + writeText,
  ].join("\n");
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
  return [
    result.summary,
    "source: " + formatPlanFileStatus(result.files.find((file) => file.role === "source")),
    "target: " + formatPlanFileStatus(result.files.find((file) => file.role === "target")),
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
  return process.stdout.isTTY ? "detailed" : "compact";
}

function outputOptions(args: ParsedArgs): OutputOptions {
  return {
    mode: outputMode(args),
    includeDiffs: booleanFlag(args, "include-diffs") || booleanFlag(args, "includeDiffs"),
    includeDetails: booleanFlag(args, "include-details") || booleanFlag(args, "includeDetails"),
  };
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

function withWarnings(text: string, warnings: FileLengthWarning[]): string {
  const formatted = formatFileLengthWarnings(warnings);
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
  tedit verify-file <file> [--json]
  tedit patch <patch-file> [--quiet] [--diff-out <file>] [--dry-run|--write]
  tedit patch --from-stdin [--quiet] [--diff-out <file>] [--dry-run|--write] < change.patch
  tedit patch --stdin [--quiet] [--diff-out <file>] [--dry-run|--write] < change.patch
  tedit actions [file] [--json]
  tedit analyze-state <file> [--json]
  tedit refactor-state <file> [--cluster <name>] [--to <hook-file> --name <hookName>] [--external-deps fail|params] [--dry-run|--write]
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
        "  tedit verify-file <file> [--json]",
        "",
        "Runs tedit parse verification for the current file without planning an edit.",
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
      return "tedit refactor-state\nUsage:\n  tedit refactor-state <file> [--cluster <name>] [--to <hook-file> --name <hookName>] [--external-deps fail|params] [--dry-run|--write]";
    case "actions":
      return "tedit actions\nUsage:\n  tedit actions [file] [--json]\n\nLists universal base actions and file-specific language actions.";
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
