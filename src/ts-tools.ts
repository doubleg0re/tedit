import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import traverseModule, { type NodePath, type TraverseOptions } from "@babel/traverse";
import * as t from "@babel/types";
import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import { parseVerificationFields, verifyParseForFile } from "./base-edit.js";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { qualityWarnings } from "./quality.js";
import { lineStartOffsets, sourceRangeForLocOrOffsets, type SourceLocRange } from "./source-range.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult, type WritePolicyFlags } from "./write-policy.js";

const traverseAst = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (
  parent: t.Node,
  opts: TraverseOptions,
) => void;

type JsonRecord = Record<string, unknown>;

type Range = {
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lineRange: string;
};

type SourcePatch = {
  start: number;
  end: number;
  text: string;
};

type ParsedTsSource = {
  ast: t.File;
  lineStarts: number[];
  lines: SourceLine[];
  offsetMap: number[];
};

type SourceLine = {
  number: number;
  start: number;
  end: number;
  endNoNewline: number;
  text: string;
};

type TsSelectorKind = "fn" | "class" | "method" | "prop" | "var";

type TsSelector = {
  kind: TsSelectorKind;
  name: string;
  owner?: string;
};

type InternalDeclaration = TsDeclarationMatch & {
  declarationRange: Range;
  bodyInnerRange?: Range;
};

export type TsDeclarationMatch = {
  id: string;
  selector: string;
  kind: TsSelectorKind;
  name: string;
  file: string;
  range: Range;
  lineRange: string;
  preview: string;
  context: string;
  canReplaceBody: boolean;
  owner?: string;
  bodyRange?: Range;
};

export type TsTriviaRelationship =
  | { kind: "own-line" }
  | { kind: "same-line-trailing" }
  | { kind: "gap-before"; gapLines: number };

export type TsTrivium = {
  id: string;
  kind: "comment" | "blank-line" | "directive";
  style?: "line" | "block" | "string";
  range: Range;
  relationship: TsTriviaRelationship;
  text: string;
  preview: string;
  lineCount: number;
};

export type TsTriviaMap = {
  sourceHash: string;
  lineEnding: "\n" | "\r\n";
  trivia: TsTrivium[];
};

export type TsEditOptions = WritePolicyFlags & {
  selector: string;
  action?: "replace-body" | "insert-before" | "insert-after";
  body?: string;
  insertBefore?: string;
  insertAfter?: string;
};

export type TsRenameOptions = WritePolicyFlags & {
  selector: string;
  to: string;
};

export type TsMoveOptions = WritePolicyFlags & {
  target: string;
  before?: string;
  after?: string;
  take?: string[];
  drop?: string[];
  confirmTrivia?: boolean;
  sourceHash?: string;
  includeTriviaContent?: boolean;
};

type MovePlacement = "before" | "after";

type MovePlan = {
  target: TsDeclarationMatch;
  anchor: TsDeclarationMatch;
  placement: MovePlacement;
  sourceHash: string;
  patch: SourcePatch;
  nextSource: string;
  moved: {
    start: number;
    end: number;
    lineRange: string;
    bytes: number;
  };
  trivia: {
    carried: JsonRecord[];
    adjacentNotCarried: JsonRecord[];
    confirmRequired: boolean;
  };
};

type LocRange = SourceLocRange;

type BabelComment = {
  type: string;
  value: string;
  start?: number | null;
  end?: number | null;
  loc?: LocRange | null;
};

type BabelToken = {
  type?: string | { label?: string };
  value?: unknown;
  start?: number | null;
  end?: number | null;
  loc?: LocRange | null;
};

type DirectiveNode = {
  value?: { value?: string };
  start?: number | null;
  end?: number | null;
  loc?: LocRange | null;
};

export function parseTsTriviaMap(source: string): TsTriviaMap {
  const parsed = parseTsSource(source);
  const comments = astComments(parsed.ast)
    .map((comment) => {
      const range = rangeForLocOrParserOffsets(comment, parsed);
      if (!range) return null;
      const { start, end } = range;
      return {
        kind: "comment" as const,
        style: comment.type === "CommentBlock" ? "block" as const : "line" as const,
        start,
        end,
        range,
        text: source.slice(start, end),
      };
    })
    .filter((comment): comment is NonNullable<typeof comment> => comment !== null);
  const directives = astDirectives(parsed.ast)
    .map((directive) => {
      const range = rangeForLocOrParserOffsets(directive, parsed);
      if (!range) return null;
      const { start, end } = range;
      return {
        kind: "directive" as const,
        style: "string" as const,
        start,
        end,
        range,
        text: source.slice(start, end),
      };
    })
    .filter((directive): directive is NonNullable<typeof directive> => directive !== null);
  const occupiedSpans = [...comments, ...directives].map((item) => ({ start: item.start, end: item.end }));
  const blankLines = parsed.lines
    .filter((line) => line.text.trim().length === 0 && !spansOverlapLine(occupiedSpans, line))
    .map((line) => {
      const range = rangeForOffsets(line.start, line.endNoNewline, parsed.lineStarts);
      return {
        kind: "blank-line" as const,
        start: line.start,
        end: line.end,
        range,
        text: source.slice(line.start, line.end),
      };
    });

  const lineCode = lineCodeMap(source, parsed.lines, occupiedSpans);
  const nodes = [...comments, ...directives, ...blankLines].sort((a, b) => a.start - b.start || a.end - b.end);
  const trivia = nodes.map((node, index): TsTrivium => ({
    id: `trivia_${index + 1}`,
    kind: node.kind,
    ...("style" in node && node.style ? { style: node.style } : {}),
    range: node.range,
    relationship: triviaRelationship(source, node, parsed.lines, lineCode),
    text: node.text,
    preview: previewText(node.text),
    lineCount: Math.max(1, node.range.endLine - node.range.line + 1),
  }));

  return {
    sourceHash: sourceHash(source),
    lineEnding: source.includes("\r\n") ? "\r\n" : "\n",
    trivia,
  };
}

export function serializeTsTriviaMap(source: string, _map: TsTriviaMap): string {
  return source;
}

export function runTsSelect(filePath: string, selector?: string): JsonRecord {
  const source = readFileSync(filePath, "utf8");
  const parsed = parseTsSource(source);
  const matches = selector
    ? declarationsForSelector(filePath, source, parsed, parseTsSelector(selector)).map(publicDeclaration)
    : collectDeclarations(filePath, source, parsed).map(publicDeclaration);
  return {
    success: true,
    kind: "ts-select",
    file: filePath,
    ...(selector ? { selector } : {}),
    matches,
    count: matches.length,
  };
}

export function runTsEdit(filePath: string, options: TsEditOptions): JsonRecord {
  if (options.write && options.dryRun) fail("INVALID_TS_EDIT", "Use only one of write or dryRun.");
  const source = readFileSync(filePath, "utf8");
  const parsed = parseTsSource(source);
  const target = resolveDeclaration(filePath, source, parsed, options.selector);
  const action = resolveTsEditAction(options);
  const patch = patchForTsEdit(source, parsed, target, action, options);
  const nextSource = applyPatch(source, patch);
  const changed = source !== nextSource;
  const parseVerification = verifyParseForFile(filePath, nextSource);
  const diff = unifiedDiff(source, nextSource, filePath);
  const warnings = qualityWarnings(filePath, source, nextSource);
  const policy = resolveWritePolicy(filePath, options);
  const shouldWrite = policy.write;
  let backup: BackupResult = {};

  if (shouldWrite && changed) {
    backup = maybeWriteBackup(filePath, source, policy, changed, nextSource);
    writeFileSync(filePath, nextSource);
  }

  return {
    success: true,
    kind: "ts-edit",
    file: filePath,
    action,
    selector: options.selector,
    target: publicDeclaration(target),
    changed,
    written: shouldWrite && changed,
    ...parseVerificationFields(parseVerification),
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(backup.path ? { backup: backup.path } : {}),
    ...(diff ? { diff } : {}),
  };
}

export function runTsRename(filePath: string, options: TsRenameOptions): JsonRecord {
  if (options.write && options.dryRun) fail("INVALID_TS_RENAME", "Use only one of write or dryRun.");
  const source = readFileSync(filePath, "utf8");
  const parsed = parseTsSource(source);
  const target = resolveDeclaration(filePath, source, parsed, options.selector);
  const isClassMember = (target.kind === "method" || target.kind === "prop") && CLASS_MEMBER_RENAME_CONTEXTS.has(target.context);
  if (target.kind !== "fn" && target.kind !== "class" && target.kind !== "var" && !isClassMember) {
    fail("TS_RENAME_UNSUPPORTED_TARGET", "declaration.rename supports single-file fn:, class:, var: declarations and class-owned method:/prop: members only.", {
      target: publicDeclaration(target),
      suggestions: [
        "Use edit/multiedit for object-literal member renames.",
        "Use refactor for multi-file or symbol-graph-aware moves.",
      ],
    });
  }
  const to = isClassMember
    ? validMemberRenameName(options.to, target.name)
    : validIdentifierName(options.to, "declaration.rename requires args.to to be a valid identifier.");
  if (to === target.name) fail("TS_RENAME_NOOP", `Target ${target.selector} is already named ${to}.`, { target: publicDeclaration(target) });

  const member = isClassMember ? memberRenamePatches(parsed, target, to) : undefined;
  const patches = member ? member.patches : renamePatchesForDeclaration(filePath, source, parsed, target, to);
  const nextSource = applyPatches(source, patches);
  const changed = source !== nextSource;
  const parseVerification = verifyParseForFile(filePath, nextSource);
  const diff = unifiedDiff(source, nextSource, filePath);
  const semanticWarnings = [...renameWarnings(source, target), ...(member ? memberRenameWarnings(target, member.unresolvedRefs) : [])];
  const warnings = [...qualityWarnings(filePath, source, nextSource), ...semanticWarnings];
  const policy = resolveWritePolicy(filePath, options);
  const shouldWrite = policy.write;
  let backup: BackupResult = {};

  if (shouldWrite && changed) {
    backup = maybeWriteBackup(filePath, source, policy, changed, nextSource);
    writeFileSync(filePath, nextSource);
  }

  return {
    success: true,
    kind: "ts-rename",
    file: filePath,
    action: "declaration.rename",
    selector: options.selector,
    target: publicDeclaration(target),
    from: target.name,
    to,
    referencesUpdated: patches.length - 1,
    changed,
    written: shouldWrite && changed,
    ...parseVerificationFields(parseVerification),
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(backup.path ? { backup: backup.path } : {}),
    ...(diff ? { diff } : {}),
  };
}

export function runTsMove(filePath: string, options: TsMoveOptions): JsonRecord {
  if (options.write && options.dryRun) fail("INVALID_TS_MOVE", "Use only one of write or dryRun.");
  const source = readFileSync(filePath, "utf8");
  const plan = planTsMove(filePath, source, options);
  const parseVerification = verifyParseForFile(filePath, plan.nextSource);
  const diff = unifiedDiff(source, plan.nextSource, filePath);
  const warnings = qualityWarnings(filePath, source, plan.nextSource);
  const policy = resolveWritePolicy(filePath, options);
  const shouldWrite = policy.write;
  let backup: BackupResult = {};

  if (shouldWrite && !options.confirmTrivia) {
    fail("TS_MOVE_REQUIRES_TRIVIA_CONFIRMATION", "ts-move writes require confirmTrivia=true after reviewing the carried trivia hint.", {
      target: plan.target,
      anchor: plan.anchor,
      placement: plan.placement,
      sourceHash: plan.sourceHash,
      trivia: plan.trivia,
      next_step_hint: "Review trivia.carried and trivia.adjacentNotCarried, then rerun with confirmTrivia=true plus take/drop overrides if needed.",
    });
  }

  const changed = source !== plan.nextSource;
  if (shouldWrite && changed) {
    backup = maybeWriteBackup(filePath, source, policy, changed, plan.nextSource);
    writeFileSync(filePath, plan.nextSource);
  }

  return {
    success: true,
    kind: "ts-move",
    file: filePath,
    changed,
    written: shouldWrite && changed,
    target: plan.target,
    anchor: plan.anchor,
    placement: plan.placement,
    moved: plan.moved,
    sourceHash: plan.sourceHash,
    trivia: plan.trivia,
    ...parseVerificationFields(parseVerification),
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(backup.path ? { backup: backup.path } : {}),
    ...(diff ? { diff } : {}),
  };
}

export function planTsMove(filePath: string, source: string, options: TsMoveOptions): MovePlan {
  const placement = movePlacement(options);
  if (options.sourceHash && options.sourceHash !== sourceHash(source)) {
    fail("TS_SOURCE_HASH_MISMATCH", "Current source hash does not match the move plan hash; inspect the file and rerun ts-move.", {
      expected: options.sourceHash,
      actual: sourceHash(source),
    });
  }
  const parsed = parseTsSource(source);
  const target = resolveDeclaration(filePath, source, parsed, options.target);
  const anchorSelector = placement === "before" ? options.before as string : options.after as string;
  const anchor = resolveDeclaration(filePath, source, parsed, anchorSelector);
  if (target.id === anchor.id) {
    fail("TS_MOVE_SAME_TARGET", "ts-move target and anchor resolved to the same declaration.", { target, anchor });
  }

  const triviaMap = parseTsTriviaMap(source);
  const moveRange = declarationMoveRange(source, parsed, target, triviaMap, options);
  const anchorMoveRange = declarationMoveRange(source, parsed, anchor, triviaMap, {});
  const insertion = placement === "before" ? anchorMoveRange.start : anchorMoveRange.end;
  if (insertion > moveRange.start && insertion < moveRange.end) {
    fail("TS_MOVE_OVERLAP", "ts-move anchor is inside the target move range.", { target, anchor });
  }

  const chunk = source.slice(moveRange.start, moveRange.end);
  const without = source.slice(0, moveRange.start) + source.slice(moveRange.end);
  const adjustedInsertion = insertion > moveRange.end ? insertion - (moveRange.end - moveRange.start) : insertion;
  const nextSource = without.slice(0, adjustedInsertion) + chunk + without.slice(adjustedInsertion);
  const patch = { start: 0, end: source.length, text: nextSource };
  return {
    target: publicDeclaration(target),
    anchor: publicDeclaration(anchor),
    placement,
    sourceHash: triviaMap.sourceHash,
    patch,
    nextSource,
    moved: {
      start: moveRange.start,
      end: moveRange.end,
      lineRange: rangeForOffsets(moveRange.start, Math.max(moveRange.start, moveRange.end - 1), parsed.lineStarts).lineRange,
      bytes: Buffer.byteLength(chunk, "utf8"),
    },
    trivia: {
      carried: summarizeTrivia(moveRange.carried, options.includeTriviaContent),
      adjacentNotCarried: summarizeTrivia(moveRange.adjacentNotCarried, options.includeTriviaContent),
      confirmRequired: true,
    },
  };
}

function resolveTsEditAction(options: TsEditOptions): "replace-body" | "insert-before" | "insert-after" {
  const inferred = [
    options.body !== undefined ? "replace-body" as const : undefined,
    options.insertBefore !== undefined ? "insert-before" as const : undefined,
    options.insertAfter !== undefined ? "insert-after" as const : undefined,
  ].filter((value): value is "replace-body" | "insert-before" | "insert-after" => value !== undefined);
  if (options.action && inferred.length > 0 && !inferred.includes(options.action)) {
    fail("INVALID_TS_EDIT", "ts-edit action conflicts with provided body/insert text.");
  }
  if (options.action) return options.action;
  if (inferred.length === 1) return inferred[0];
  fail("INVALID_TS_EDIT", "ts-edit requires exactly one of body, insertBefore, or insertAfter.");
}

function patchForTsEdit(source: string, parsed: ParsedTsSource, target: InternalDeclaration, action: "replace-body" | "insert-before" | "insert-after", options: TsEditOptions): SourcePatch {
  if (action === "replace-body") {
    if (options.body === undefined) fail("INVALID_TS_EDIT", "ts-edit action=replace-body requires body.");
    if (!target.bodyInnerRange) {
      fail("TS_BODY_UNAVAILABLE", `Target ${target.selector} does not have a block body tedit can replace safely.`, {
        target: publicDeclaration(target),
        suggestions: ["Use insert-before/insert-after for declarations without a block body.", "Use universal edit for a smaller exact text replacement."],
      });
    }
    return { start: target.bodyInnerRange.start, end: target.bodyInnerRange.end, text: normalizeTsEditBody(options.body) };
  }

  const text = ensureDeclarationInsertText(action === "insert-before" ? options.insertBefore : options.insertAfter, source);
  if (action === "insert-before") {
    return { start: lineStartForOffset(parsed.lines, target.declarationRange.start), end: lineStartForOffset(parsed.lines, target.declarationRange.start), text };
  }
  const end = lineEndIncludingNewline(parsed.lines, target.declarationRange.end);
  return { start: end, end, text };
}

function renamePatchesForDeclaration(filePath: string, source: string, parsed: ParsedTsSource, target: InternalDeclaration, to: string): SourcePatch[] {
  let patches: SourcePatch[] | undefined;

  traverseAst(parsed.ast, {
    FunctionDeclaration(path) {
      if (!path.node.id || target.kind !== "fn") return;
      if (!sameDeclarationPath(path as NodePath<t.Node>, parsed, target)) return;
      patches = bindingRenamePatches(path, path.node.id, parsed, to);
      path.stop();
    },
    ClassDeclaration(path) {
      if (!path.node.id || target.kind !== "class") return;
      if (!sameDeclarationPath(path as NodePath<t.Node>, parsed, target)) return;
      patches = bindingRenamePatches(path, path.node.id, parsed, to);
      path.stop();
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || target.kind !== "var") return;
      if (!sameDeclarationPath(path as NodePath<t.Node>, parsed, target)) return;
      patches = bindingRenamePatches(path, path.node.id, parsed, to);
      path.stop();
    },
  });

  if (!patches) {
    fail("TS_RENAME_BINDING_UNAVAILABLE", `Could not resolve a rename binding for ${target.selector}.`, {
      target: publicDeclaration(target),
      suggestions: ["Use edit/multiedit for this declaration shape.", "Run select to confirm the target selector."],
    });
  }
  if (patches.length === 0) {
    fail("TS_RENAME_BINDING_UNAVAILABLE", `No identifier ranges were available for ${target.selector}.`, {
      target: publicDeclaration(target),
    });
  }
  return dedupePatches(patches);
}

function sameDeclarationPath(path: NodePath<t.Node>, parsed: ParsedTsSource, target: InternalDeclaration): boolean {
  const range = declarationRangeForPath(path, parsed);
  return range.start === target.declarationRange.start && range.end === target.declarationRange.end;
}

function bindingRenamePatches(path: NodePath<t.Node>, identifier: t.Identifier, parsed: ParsedTsSource, to: string): SourcePatch[] {
  const binding = path.scope.getBinding(identifier.name);
  if (!binding) {
    fail("TS_RENAME_BINDING_UNAVAILABLE", `Could not resolve binding for ${identifier.name}.`, {
      suggestions: ["Use edit/multiedit for this declaration shape."],
    });
  }
  const nodes = [binding.identifier, ...binding.referencePaths.map((referencePath) => referencePath.node)]
    .filter((node): node is t.Identifier => t.isIdentifier(node));
  return nodes.map((node) => {
    const range = rangeForNode(node, parsed);
    return { start: range.start, end: range.end, text: to };
  });
}

const CLASS_MEMBER_RENAME_CONTEXTS = new Set(["class method", "class private method", "class property", "class private property"]);

function validMemberRenameName(value: string, currentName: string): string {
  const isPrivate = currentName.startsWith("#");
  if (!isPrivate && value.startsWith("#")) {
    fail("INVALID_TS_RENAME", "declaration.rename cannot change a public member into a private one.", { received: value });
  }
  const plain = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[$A-Z_a-z][$\w]*$/.test(plain)) {
    fail("INVALID_TS_RENAME", "declaration.rename requires args.to to be a valid member name.", { received: value });
  }
  return isPrivate ? `#${plain}` : plain;
}

type MemberRenamePlan = { patches: SourcePatch[]; unresolvedRefs: number };

function memberRenamePatches(parsed: ParsedTsSource, target: InternalDeclaration, to: string): MemberRenamePlan {
  const isPrivate = target.name.startsWith("#");
  const referenceName = isPrivate ? target.name.slice(1) : target.name;
  const patches: SourcePatch[] = [];
  let found = false;

  const capture = (path: NodePath<t.ClassMethod | t.ClassPrivateMethod | t.ClassProperty | t.ClassPrivateProperty>): void => {
    if (found || !sameDeclarationPath(path as NodePath<t.Node>, parsed, target)) return;
    if (!t.isIdentifier(path.node.key) && !t.isPrivateName(path.node.key)) return;
    found = true;
    const keyRange = rangeForNode(path.node.key, parsed);
    patches.push({ start: keyRange.start, end: keyRange.end, text: to });
    const bodyPath = path.parentPath;
    if (bodyPath.isClassBody()) {
      patches.push(...(isPrivate
        ? privateMemberReferencePatches(bodyPath, referenceName, to, parsed)
        : thisMemberReferencePatches(bodyPath, referenceName, to, parsed)));
    }
    path.stop();
  };

  traverseAst(parsed.ast, {
    ClassMethod(path) { if (target.kind === "method") capture(path); },
    ClassPrivateMethod(path) { if (target.kind === "method") capture(path); },
    ClassProperty(path) { if (target.kind === "prop") capture(path); },
    ClassPrivateProperty(path) { if (target.kind === "prop") capture(path); },
  });

  if (!found) {
    fail("TS_RENAME_BINDING_UNAVAILABLE", `Could not resolve a rename target for ${target.selector}.`, {
      target: publicDeclaration(target),
      suggestions: ["Run select to confirm the target selector."],
    });
  }
  const deduped = dedupePatches(patches);
  return { patches: deduped, unresolvedRefs: countUnpatchedMemberRefs(parsed, referenceName, isPrivate, deduped) };
}

// private 멤버는 클래스 밖 접근이 문법상 불가라 body 안 참조 전부가 안전한 갱신 대상.
function privateMemberReferencePatches(classBody: NodePath<t.ClassBody>, name: string, to: string, parsed: ParsedTsSource): SourcePatch[] {
  const patches: SourcePatch[] = [];
  classBody.traverse({
    Class(path) {
      if (classBodyDeclaresPrivate(path.node.body, name)) path.skip();
    },
    PrivateName(path) {
      if (path.node.id.name !== name) return;
      const range = rangeForNode(path.node, parsed);
      patches.push({ start: range.start, end: range.end, text: to });
    },
  });
  return patches;
}

function classBodyDeclaresPrivate(body: t.ClassBody, name: string): boolean {
  return body.body.some((memberNode) =>
    (t.isClassPrivateMethod(memberNode) || t.isClassPrivateProperty(memberNode)) && memberNode.key.id.name === name);
}

// public 멤버는 this가 클래스 인스턴스로 보장되는 범위만 갱신: arrow는 투과, function/중첩 class에서 중단.
function thisMemberReferencePatches(classBody: NodePath<t.ClassBody>, name: string, to: string, parsed: ParsedTsSource): SourcePatch[] {
  const patches: SourcePatch[] = [];
  const record = (object: t.Node, property: t.Node, computed: boolean): void => {
    if (computed || !t.isThisExpression(object) || !t.isIdentifier(property) || property.name !== name) return;
    const range = rangeForNode(property, parsed);
    patches.push({ start: range.start, end: range.end, text: to });
  };
  classBody.traverse({
    FunctionDeclaration(path) { path.skip(); },
    FunctionExpression(path) { path.skip(); },
    ObjectMethod(path) { path.skip(); },
    Class(path) { path.skip(); },
    MemberExpression(path) { record(path.node.object, path.node.property, path.node.computed); },
    OptionalMemberExpression(path) { record(path.node.object, path.node.property, path.node.computed); },
  });
  return patches;
}

function countUnpatchedMemberRefs(parsed: ParsedTsSource, name: string, isPrivate: boolean, patches: SourcePatch[]): number {
  const patched = new Set(patches.map((patch) => `${patch.start}:${patch.end}`));
  let count = 0;
  const record = (property: t.Node, computed: boolean): void => {
    const matches = isPrivate
      ? t.isPrivateName(property) && property.id.name === name
      : !computed && t.isIdentifier(property) && property.name === name;
    if (!matches) return;
    const range = rangeForNode(property, parsed);
    if (!patched.has(`${range.start}:${range.end}`)) count += 1;
  };
  traverseAst(parsed.ast, {
    MemberExpression(path) { record(path.node.property, path.node.computed); },
    OptionalMemberExpression(path) { record(path.node.property, path.node.computed); },
  });
  return count;
}

function memberRenameWarnings(target: InternalDeclaration, unresolvedRefs: number): JsonRecord[] {
  if (unresolvedRefs === 0) return [];
  return [{
    code: "TS_RENAME_MEMBER_EXTERNAL_REFS",
    level: "warn",
    file: target.file,
    selector: target.selector,
    count: unresolvedRefs,
    message: `Renamed class member ${target.name} but ${unresolvedRefs} same-file member access(es) outside the safe this scope were not updated.`,
    next_step_hint: "Review the remaining accesses with search, update them via edit/multiedit, or run a typecheck via verify.",
  }];
}

function validIdentifierName(value: string, message: string): string {
  if (!/^[$A-Z_a-z][$\w]*$/.test(value)) fail("INVALID_TS_RENAME", message, { received: value });
  return value;
}

function dedupePatches(patches: SourcePatch[]): SourcePatch[] {
  const byRange = new Map<string, SourcePatch>();
  for (const patch of patches) byRange.set(`${patch.start}:${patch.end}`, patch);
  return [...byRange.values()].sort((a, b) => b.start - a.start);
}

function applyPatches(source: string, patches: SourcePatch[]): string {
  let next = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) next = applyPatch(next, patch);
  return next;
}

function renameWarnings(source: string, target: InternalDeclaration): JsonRecord[] {
  const declaration = source.slice(target.declarationRange.start, target.declarationRange.end);
  if (!/^\s*export\b/.test(declaration)) return [];
  return [{
    code: "TS_RENAME_EXPORTED_SYMBOL",
    level: "warn",
    file: target.file,
    selector: target.selector,
    message: `Renamed exported symbol ${target.name} in one file only; external imports may need updates.`,
    next_step_hint: "Run a typecheck via verify or use refactor for cross-file symbol-aware changes.",
  }];
}

function normalizeTsEditBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return body;
  // ponytail: accept the common agent mistake of passing the whole block; nested blocks can still be passed as {{...}}.
  return trimmed.slice(1, -1);
}

function movePlacement(options: TsMoveOptions): MovePlacement {
  const before = options.before !== undefined;
  const after = options.after !== undefined;
  if (before === after) fail("INVALID_TS_MOVE", "ts-move requires exactly one of before or after.");
  return before ? "before" : "after";
}

function declarationMoveRange(source: string, parsed: ParsedTsSource, declaration: InternalDeclaration, triviaMap: TsTriviaMap, options: Pick<TsMoveOptions, "take" | "drop">): { start: number; end: number; carried: TsTrivium[]; adjacentNotCarried: TsTrivium[] } {
  const declarationLine = lineForOffset(parsed.lines, declaration.declarationRange.start);
  const declarationLineStart = lineStartForOffset(parsed.lines, declaration.declarationRange.start);
  const declarationLineEnd = lineEndIncludingNewline(parsed.lines, declaration.declarationRange.end);
  const defaultCarried = defaultCarriedTrivia(triviaMap.trivia, declarationLine, declarationLineStart, declarationLineEnd);
  const adjacent = adjacentTrivia(triviaMap.trivia, declarationLine, declarationLineStart, declarationLineEnd, defaultCarried);
  const carried = applyTriviaOverrides(defaultCarried, adjacent, options);
  const leadingCarried = carried.filter((trivium) => trivium.range.end <= declaration.declarationRange.start);
  const moveStart = leadingCarried.length > 0 ? Math.min(...leadingCarried.map((trivium) => lineStartForOffset(parsed.lines, trivium.range.start))) : declarationLineStart;
  ensureContiguousLeadingTrivia(source, triviaMap.trivia, carried, moveStart, declarationLineStart);
  return {
    start: moveStart,
    end: declarationLineEnd,
    carried,
    adjacentNotCarried: adjacent.filter((trivium) => !carried.some((item) => item.id === trivium.id)),
  };
}

function defaultCarriedTrivia(trivia: TsTrivium[], declarationLine: SourceLine, declarationStart: number, declarationEnd: number): TsTrivium[] {
  const carried: TsTrivium[] = [];
  const leadingComments = trivia
    .filter((trivium) => trivium.kind === "comment" && trivium.range.end <= declarationStart && trivium.relationship.kind === "own-line")
    .sort((a, b) => b.range.end - a.range.end);
  let expectedLine = declarationLine.number - 1;
  for (const comment of leadingComments) {
    if (comment.range.endLine !== expectedLine) continue;
    carried.push(comment);
    expectedLine = comment.range.line - 1;
  }
  carried.reverse();
  carried.push(...trivia.filter((trivium) => trivium.kind === "comment" && trivium.relationship.kind === "same-line-trailing" && trivium.range.start >= declarationStart && trivium.range.start < declarationEnd));
  return carried;
}

function adjacentTrivia(trivia: TsTrivium[], declarationLine: SourceLine, declarationStart: number, declarationEnd: number, carried: TsTrivium[]): TsTrivium[] {
  const carriedIds = new Set(carried.map((trivium) => trivium.id));
  return trivia.filter((trivium) => {
    if (carriedIds.has(trivium.id)) return false;
    if (trivium.kind !== "comment") return false;
    if (trivium.range.end <= declarationStart && declarationLine.number - trivium.range.endLine <= 6) return true;
    if (trivium.range.start >= declarationEnd && trivium.range.line - declarationLine.number <= 6) return true;
    return false;
  });
}

function applyTriviaOverrides(defaultCarried: TsTrivium[], adjacent: TsTrivium[], options: Pick<TsMoveOptions, "take" | "drop">): TsTrivium[] {
  const byId = new Map([...defaultCarried, ...adjacent].map((trivium) => [trivium.id, trivium]));
  const carried = new Map(defaultCarried.map((trivium) => [trivium.id, trivium]));
  for (const id of options.take ?? []) {
    const trivium = byId.get(id);
    if (!trivium) fail("TS_TRIVIA_ID_NOT_FOUND", `Unknown trivia id for take: ${id}.`, { available: [...byId.keys()] });
    carried.set(id, trivium);
  }
  for (const id of options.drop ?? []) {
    const trivium = byId.get(id);
    if (!trivium) fail("TS_TRIVIA_ID_NOT_FOUND", `Unknown trivia id for drop: ${id}.`, { available: [...byId.keys()] });
    if (trivium.relationship.kind === "same-line-trailing") {
      fail("TS_TRIVIA_DROP_UNSUPPORTED", "Cannot drop a same-line trailing comment from a declaration move; it shares the declaration line.", { id, trivium: summarizeOneTrivia(trivium, false) });
    }
    carried.delete(id);
  }
  return [...carried.values()].sort((a, b) => a.range.start - b.range.start);
}

function ensureContiguousLeadingTrivia(source: string, trivia: TsTrivium[], carried: TsTrivium[], moveStart: number, declarationStart: number): void {
  const carriedIds = new Set(carried.map((trivium) => trivium.id));
  const droppedInside = trivia.filter((trivium) => {
    return trivium.kind === "comment" && trivium.range.start >= moveStart && trivium.range.end <= declarationStart && !carriedIds.has(trivium.id);
  });
  if (droppedInside.length > 0) {
    fail("TS_TRIVIA_NON_CONTIGUOUS_OVERRIDE", "Trivia overrides would require a non-contiguous leading move range.", {
      dropped_inside_range: droppedInside.map((trivium) => summarizeOneTrivia(trivium, false)),
      selected_range: previewText(source.slice(moveStart, declarationStart)),
      next_step_hint: "Only drop comments from the outer edge of the carried leading block, or use a manual edit for a custom split.",
    });
  }
}

function collectDeclarations(filePath: string, source: string, parsed: ParsedTsSource): InternalDeclaration[] {
  const declarations: InternalDeclaration[] = [];
  const push = (kind: TsSelectorKind, name: string, path: NodePath<t.Node>, context: string, owner?: string, bodyNode?: t.BlockStatement | t.ClassBody): void => {
    const declarationRange = declarationRangeForPath(path, parsed);
    const bodyInnerRange = bodyNode ? innerBodyRange(bodyNode, parsed) : undefined;
    declarations.push({
      id: `ts_${declarations.length + 1}`,
      selector: selectorFor(kind, name, owner),
      kind,
      name,
      ...(owner ? { owner } : {}),
      file: filePath,
      range: declarationRange,
      declarationRange,
      lineRange: declarationRange.lineRange,
      preview: preview(source, declarationRange.start, declarationRange.end),
      context,
      canReplaceBody: bodyInnerRange !== undefined,
      ...(bodyInnerRange ? { bodyRange: bodyInnerRange, bodyInnerRange } : {}),
    });
  };

  traverseAst(parsed.ast, {
    FunctionDeclaration(path) {
      if (!path.node.id) return;
      push("fn", path.node.id.name, path as NodePath<t.Node>, "function declaration", undefined, path.node.body);
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const bodyNode = functionLikeBody(path.node.init);
      push("var", path.node.id.name, path as NodePath<t.Node>, "variable declaration", undefined, bodyNode);
      push("prop", path.node.id.name, path as NodePath<t.Node>, "variable declaration", undefined, bodyNode);
      if (bodyNode) push("fn", path.node.id.name, path as NodePath<t.Node>, "function-like variable", undefined, bodyNode);
    },
    ClassDeclaration(path) {
      if (!path.node.id) return;
      push("class", path.node.id.name, path as NodePath<t.Node>, "class declaration", undefined, path.node.body);
    },
    ClassMethod(path) {
      const owner = classOwnerName(path);
      const name = propertyName(path.node.key);
      if (!owner || !name) return;
      push("method", name, path as NodePath<t.Node>, "class method", owner, path.node.body);
    },
    ClassPrivateMethod(path) {
      const owner = classOwnerName(path);
      const name = privateName(path.node.key);
      if (!owner || !name) return;
      push("method", name, path as NodePath<t.Node>, "class private method", owner, path.node.body);
    },
    ClassProperty(path) {
      const owner = classOwnerName(path);
      const name = propertyName(path.node.key);
      if (!owner || !name) return;
      push("prop", name, path as NodePath<t.Node>, "class property", owner, functionLikeBody(path.node.value));
    },
    ClassPrivateProperty(path) {
      const owner = classOwnerName(path);
      const name = privateName(path.node.key);
      if (!owner || !name) return;
      push("prop", name, path as NodePath<t.Node>, "class private property", owner, functionLikeBody(path.node.value));
    },
    ObjectMethod(path) {
      const owner = objectOwnerName(path);
      const name = propertyName(path.node.key);
      if (!owner || !name) return;
      push("method", name, path as NodePath<t.Node>, "object method", owner, path.node.body);
    },
    ObjectProperty(path) {
      const owner = objectOwnerName(path);
      const name = propertyName(path.node.key);
      if (!name) return;
      const bodyNode = functionLikeBody(path.node.value);
      push("prop", name, path as NodePath<t.Node>, owner ? "object property" : "property", owner, bodyNode);
      if (owner && bodyNode) push("method", name, path as NodePath<t.Node>, "function-valued object property", owner, bodyNode);
    },
  });

  return declarations;
}

function declarationsForSelector(filePath: string, source: string, parsed: ParsedTsSource, selector: TsSelector): InternalDeclaration[] {
  return collectDeclarations(filePath, source, parsed).filter((declaration) => {
    if (declaration.kind !== selector.kind) return false;
    if (declaration.name !== selector.name) return false;
    if (selector.owner !== undefined && declaration.owner !== selector.owner) return false;
    if (selector.owner === undefined && (selector.kind === "method" || declaration.owner !== undefined && selector.kind === "prop")) return false;
    return true;
  });
}

function resolveDeclaration(filePath: string, source: string, parsed: ParsedTsSource, selectorText: string): InternalDeclaration {
  const selector = parseTsSelector(selectorText);
  const matches = declarationsForSelector(filePath, source, parsed, selector);
  if (matches.length === 0) {
    const candidates = nearbyDeclarations(filePath, source, parsed, selector);
    fail("TS_DECLARATION_MATCH_NONE", `No TS declaration matched ${selectorText}.`, {
      selector: selectorText,
      candidates: candidates.map(publicDeclaration),
      suggestions: [
        "Run ts-select without a selector to list declarations.",
        ...(candidates[0] ? [`Try ${JSON.stringify(candidates[0].selector)}.`] : []),
      ],
    });
  }
  if (matches.length > 1) {
    fail("TS_DECLARATION_MATCH_NOT_UNIQUE", `TS selector ${selectorText} matched ${matches.length} declarations.`, {
      selector: selectorText,
      matches: matches.map(publicDeclaration),
      next_step_hint: "Use an owner-qualified selector such as method:ClassName.methodName or prop:ObjectName.key.",
    });
  }
  return matches[0];
}

function nearbyDeclarations(filePath: string, source: string, parsed: ParsedTsSource, selector: TsSelector): InternalDeclaration[] {
  return collectDeclarations(filePath, source, parsed)
    .filter((declaration) => declaration.kind === selector.kind || declaration.name.includes(selector.name) || selector.name.includes(declaration.name))
    .slice(0, 8);
}

function parseTsSelector(input: string): TsSelector {
  const match = input.match(/^(fn|function|class|method|prop|var):(.+)$/);
  if (!match) {
    fail("INVALID_TS_SELECTOR", `Invalid TS selector "${input}". Expected fn:name, class:Name, method:Owner.name, prop:name, prop:Owner.name, or var:name.`);
  }
  const rawKind = match[1];
  const kind = rawKind === "function" ? "fn" : rawKind as TsSelectorKind;
  const rawName = match[2].trim();
  if (!rawName) fail("INVALID_TS_SELECTOR", "TS selector name cannot be empty.");
  if (kind === "method" || rawName.includes(".") && kind === "prop") {
    const dot = rawName.lastIndexOf(".");
    if (dot <= 0 || dot === rawName.length - 1) fail("INVALID_TS_SELECTOR", `Invalid owner-qualified selector "${input}".`);
    return { kind, owner: rawName.slice(0, dot), name: rawName.slice(dot + 1) };
  }
  return { kind, name: rawName };
}

function publicDeclaration(declaration: InternalDeclaration | TsDeclarationMatch): TsDeclarationMatch {
  const { declarationRange: _declarationRange, bodyInnerRange: _bodyInnerRange, ...publicFields } = declaration as InternalDeclaration;
  return publicFields;
}

function selectorFor(kind: TsSelectorKind, name: string, owner?: string): string {
  return owner ? `${kind}:${owner}.${name}` : `${kind}:${name}`;
}

function parseTsSource(source: string): ParsedTsSource {
  return {
    ast: recast.parse(source, { parser: babelTsParser }) as unknown as t.File,
    lineStarts: lineStartOffsets(source),
    lines: sourceLines(source),
    offsetMap: normalizedOffsetMap(source),
  };
}

function functionLikeBody(node: t.Node | null | undefined): t.BlockStatement | undefined {
  if (!node) return undefined;
  if ((t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) && t.isBlockStatement(node.body)) return node.body;
  return undefined;
}

function declarationRangeForPath(path: NodePath<t.Node>, parsed: ParsedTsSource): Range {
  const rangeNode = declarationRangeNode(path);
  return rangeForNode(rangeNode, parsed);
}

function declarationRangeNode(path: NodePath<t.Node>): t.Node {
  if (path.isVariableDeclarator() && path.parentPath?.isVariableDeclaration()) {
    const declaration = path.parentPath;
    if (declaration.parentPath?.isExportNamedDeclaration()) return declaration.parentPath.node;
    return declaration.node;
  }
  if ((path.isFunctionDeclaration() || path.isClassDeclaration()) && (path.parentPath?.isExportNamedDeclaration() || path.parentPath?.isExportDefaultDeclaration())) {
    return path.parentPath.node;
  }
  return path.node;
}

function innerBodyRange(node: t.BlockStatement | t.ClassBody, parsed: ParsedTsSource): Range | undefined {
  const range = rangeForNode(node, parsed);
  if (range.end < range.start + 2) return undefined;
  return rangeForOffsets(range.start + 1, range.end - 1, parsed.lineStarts);
}

function rangeForNode(node: t.Node, parsed: ParsedTsSource): Range {
  const range = rangeForLocOrParserOffsets(node, parsed);
  if (!range) fail("TS_RANGE_UNAVAILABLE", "AST node does not have source offsets.");
  return range;
}

function rangeForLocOrParserOffsets(node: { loc?: LocRange | null; start?: number | null; end?: number | null }, parsed: ParsedTsSource): Range | null {
  const range = sourceRangeForLocOrOffsets(node, parsed.lineStarts, (offset) => sourceOffset(parsed, offset));
  return range ? rangeForOffsets(range.start, range.end, parsed.lineStarts) : null;
}

function rangeForOffsets(start: number, end: number, lineStarts: number[]): Range {
  const loc = offsetLoc(start, lineStarts);
  const endLoc = offsetLoc(Math.max(start, end - 1), lineStarts);
  return {
    start,
    end,
    line: loc.line,
    column: loc.column,
    endLine: endLoc.line,
    endColumn: endLoc.column,
    lineRange: loc.line === endLoc.line ? String(loc.line) : `${loc.line}:${endLoc.line}`,
  };
}

function offsetLoc(offset: number, lineStarts: number[]): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const index = Math.max(0, high);
  return { line: index + 1, column: offset - lineStarts[index] + 1 };
}

function normalizedOffsetMap(source: string): number[] {
  const map: number[] = [];
  let normalized = 0;
  for (let index = 0; index < source.length; index++) {
    map[normalized] = index;
    if (source[index] === "\r" && source[index + 1] === "\n") continue;
    normalized++;
  }
  map[normalized] = source.length;
  return map;
}

function sourceOffset(parsed: ParsedTsSource, parserOffset: number): number {
  return parsed.offsetMap[parserOffset] ?? parserOffset;
}

function sourceLines(source: string): SourceLine[] {
  if (source.length === 0) return [{ number: 1, start: 0, end: 0, endNoNewline: 0, text: "" }];
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const endNoNewline = newline < 0 ? end : source[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({
      number: lines.length + 1,
      start,
      end,
      endNoNewline,
      text: source.slice(start, endNoNewline),
    });
    start = end;
  }
  return lines;
}

function lineForOffset(lines: SourceLine[], offset: number): SourceLine {
  return lines.find((line) => offset >= line.start && offset < line.end) ?? lines[lines.length - 1];
}

function lineStartForOffset(lines: SourceLine[], offset: number): number {
  return lineForOffset(lines, offset).start;
}

function lineEndIncludingNewline(lines: SourceLine[], offset: number): number {
  return lineForOffset(lines, Math.max(0, offset - 1)).end;
}

function astComments(ast: t.File): BabelComment[] {
  const direct = (ast as unknown as { comments?: BabelComment[] }).comments ?? [];
  const tokens = ((ast as unknown as { tokens?: BabelToken[] }).tokens ?? [])
    .filter((token) => tokenTypeLabel(token) === "CommentLine" || tokenTypeLabel(token) === "CommentBlock")
    .map((token): BabelComment => ({
      type: tokenTypeLabel(token),
      value: typeof token.value === "string" ? token.value : "",
      start: token.start,
      end: token.end,
      loc: token.loc,
    }));
  const byRange = new Map<string, BabelComment>();
  for (const comment of [...direct, ...tokens]) {
    if (typeof comment.start !== "number" || typeof comment.end !== "number") continue;
    byRange.set(`${comment.start}:${comment.end}`, comment);
  }
  return [...byRange.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

function tokenTypeLabel(token: BabelToken): string {
  if (typeof token.type === "string") return token.type;
  if (token.type && typeof token.type === "object" && typeof token.type.label === "string") return token.type.label;
  return "";
}

function astDirectives(ast: t.File): DirectiveNode[] {
  return ((ast.program as unknown as { directives?: DirectiveNode[] }).directives ?? []);
}

function spansOverlapLine(spans: Array<{ start: number; end: number }>, line: SourceLine): boolean {
  return spans.some((span) => span.start < line.end && span.end > line.start);
}

function lineCodeMap(source: string, lines: SourceLine[], spans: Array<{ start: number; end: number }>): Map<number, boolean> {
  const result = new Map<number, boolean>();
  for (const line of lines) {
    let text = "";
    let cursor = line.start;
    const overlaps = spans.filter((span) => span.start < line.endNoNewline && span.end > line.start).sort((a, b) => a.start - b.start);
    for (const span of overlaps) {
      const start = Math.max(cursor, span.start);
      if (start > cursor) text += source.slice(cursor, start);
      cursor = Math.max(cursor, Math.min(span.end, line.endNoNewline));
    }
    if (cursor < line.endNoNewline) text += source.slice(cursor, line.endNoNewline);
    result.set(line.number, text.trim().length > 0);
  }
  return result;
}

function triviaRelationship(source: string, node: { kind: TsTrivium["kind"]; start: number; end: number; range: Range }, lines: SourceLine[], lineCode: Map<number, boolean>): TsTriviaRelationship {
  if (node.kind === "directive") return { kind: "own-line" };
  if (node.kind === "blank-line") return { kind: "gap-before", gapLines: 1 };
  const startLine = lineForOffset(lines, node.start);
  const before = source.slice(startLine.start, node.start);
  if (before.trim().length > 0) return { kind: "same-line-trailing" };
  const nextCodeLine = nextCodeLineAfter(lines, lineCode, node.range.endLine);
  if (!nextCodeLine) return { kind: "gap-before", gapLines: 0 };
  const gapLines = countBlankLines(lines, node.range.endLine + 1, nextCodeLine.number - 1);
  return gapLines === 0 ? { kind: "own-line" } : { kind: "gap-before", gapLines };
}

function nextCodeLineAfter(lines: SourceLine[], lineCode: Map<number, boolean>, startLine: number): SourceLine | undefined {
  for (const line of lines) {
    if (line.number <= startLine) continue;
    if (lineCode.get(line.number)) return line;
  }
  return undefined;
}

function countBlankLines(lines: SourceLine[], startLine: number, endLine: number): number {
  return lines.filter((line) => line.number >= startLine && line.number <= endLine && line.text.trim().length === 0).length;
}

function propertyName(node: t.Node): string | undefined {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return String(node.value);
  if (t.isPrivateName(node)) return privateName(node);
  return undefined;
}

function privateName(node: t.PrivateName): string {
  return `#${node.id.name}`;
}

function classOwnerName(path: NodePath<t.Node>): string | undefined {
  const classPath = path.findParent((parent) => parent.isClassDeclaration() || parent.isClassExpression());
  if (!classPath) return undefined;
  const node = classPath.node;
  if ((t.isClassDeclaration(node) || t.isClassExpression(node)) && node.id) return node.id.name;
  return undefined;
}

function objectOwnerName(path: NodePath<t.Node>): string | undefined {
  const objectPath = path.parentPath;
  if (!objectPath?.isObjectExpression()) return undefined;
  const declarator = objectPath.parentPath;
  if (declarator?.isVariableDeclarator() && t.isIdentifier(declarator.node.id)) return declarator.node.id.name;
  return undefined;
}

function ensureDeclarationInsertText(value: string | undefined, source: string): string {
  if (value === undefined) fail("INVALID_TS_EDIT", "ts-edit insert action requires insert text.");
  if (value.length === 0) fail("INVALID_TS_EDIT", "ts-edit insert text cannot be empty.");
  return value.endsWith("\n") || value.endsWith("\r\n") ? value : value + (source.includes("\r\n") ? "\r\n" : "\n");
}

function applyPatch(source: string, patch: SourcePatch): string {
  return source.slice(0, patch.start) + patch.text + source.slice(patch.end);
}

function summarizeTrivia(trivia: TsTrivium[], includeContent: boolean | undefined): JsonRecord[] {
  return trivia.map((trivium) => summarizeOneTrivia(trivium, includeContent));
}

function summarizeOneTrivia(trivium: TsTrivium, includeContent: boolean | undefined): JsonRecord {
  const relationship = trivium.relationship.kind === "gap-before" ? `gap-before(${trivium.relationship.gapLines})` : trivium.relationship.kind;
  return {
    id: trivium.id,
    kind: trivium.kind,
    relationship,
    lineRange: trivium.range.lineRange,
    preview: trivium.preview,
    lineCount: trivium.lineCount,
    ...(includeContent ? { text: trivium.text } : {}),
  };
}

function preview(source: string, start: number, end: number): string {
  const beforeStart = Math.max(0, source.lastIndexOf("\n", start - 1) + 1);
  const afterEnd = source.indexOf("\n", end);
  const lineEnd = afterEnd < 0 ? source.length : afterEnd;
  return previewText(source.slice(beforeStart, lineEnd));
}

function previewText(text: string): string {
  const compact = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  return compact.length > 120 ? compact.slice(0, 117) + "..." : compact;
}

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}
