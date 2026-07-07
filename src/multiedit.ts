import { existsSync, readFileSync } from "node:fs";
import {
  parseLineRange,
  parseVerificationFields,
  planBaseEdit,
  verifyParseForEdit,
  type BaseEditMutation,
  type BaseFindStrategy,
  type ParseVerificationFields,
} from "./base-edit.js";
import { fail, TeditError } from "./errors.js";
import { commitWorkspaceUpdates, type WorkspaceFileChange, type WorkspaceFlowOptions } from "./workspace-flow.js";

export type MultieditResult = {
  success: true;
  editCount: number;
  fileCount: number;
  results: MultieditStepResult[];
  parse: Array<{ file: string } & ParseVerificationFields>;
  files: WorkspaceFileChange[];
};

export type MultieditStepResult = {
  edit: number;
  file: string;
  action: BaseEditMutation["kind"];
  strategy: BaseFindStrategy["kind"];
  changed: boolean;
  matches: ReturnType<typeof planBaseEdit>["matches"];
  guardrails: ReturnType<typeof planBaseEdit>["guardrails"];
  diff?: string;
};

type MultieditFileState = {
  file: string;
  original: string;
  next: string;
};

export function runMultieditInput(input: string, options: WorkspaceFlowOptions = {}): MultieditResult {
  return runMultiedit(parseMultieditInput(input), options);
}

export function parseMultieditInput(input: string): unknown[] {
  let root: unknown;
  try {
    root = JSON.parse(input);
  } catch (error) {
    fail("INVALID_MULTIEDIT", "multiedit input must be valid JSON.", {
      parser_error: error instanceof Error ? error.message : String(error),
      suggestions: [
        "Validate stdin as JSON before piping it to tedit multiedit.",
        "Pass an edits array or an object shaped like {\"edits\":[...]}.",
      ],
    });
  }

  if (Array.isArray(root)) return root;
  if (root && typeof root === "object" && Array.isArray((root as { edits?: unknown }).edits)) {
    return (root as { edits: unknown[] }).edits;
  }
  fail("INVALID_MULTIEDIT", "multiedit input must be an array or an object with an edits array.", multieditShapeDetails(root));
}

function multieditShapeDetails(root: unknown): Record<string, unknown> {
  if (root && typeof root === "object" && !Array.isArray(root)) {
    const record = root as Record<string, unknown>;
    const nested = record.multiedit;
    if (nested && typeof nested === "object" && !Array.isArray(nested) && Array.isArray((nested as { edits?: unknown }).edits)) {
      return {
        detected: "search-text-result",
        suggestions: [
          "Pass the nested multiedit object, e.g. jq '.multiedit' | tedit multiedit --from-stdin --dry-run.",
        ],
      };
    }
  }
  return {
    expected: "array or object with edits array",
    suggestions: ["Pass an edits array or an object shaped like {\"edits\":[...]}."],
  };
}

export function runMultiedit(edits: unknown[], options: WorkspaceFlowOptions = {}): MultieditResult {
  const states = new Map<string, MultieditFileState>();
  const results: MultieditStepResult[] = [];

  edits.forEach((rawEdit, index) => {
    const edit = normalizeEdit(rawEdit, index);
    const state = ensureState(states, edit.file);
    try {
      const plan = planBaseEdit({
        filePath: edit.file,
        source: state.next,
        strategy: edit.strategy,
        mutation: edit.mutation,
        replaceAll: edit.replaceAll,
        ...(edit.expectCount === undefined ? {} : { expectCount: edit.expectCount }),
        verifyParse: false,
      });
      state.next = plan.nextSource;
      results.push({
        edit: index,
        file: edit.file,
        action: plan.action,
        strategy: plan.strategy,
        changed: plan.changed,
        matches: plan.matches,
        guardrails: plan.guardrails,
        ...(plan.diff ? { diff: plan.diff } : {}),
      });
    } catch (error) {
      rethrowWithEditContext(error, index, edit.file);
    }
  });

  const parse = [...states.values()].map((state) => {
    try {
      const verification = verifyParseForEdit(state.file, state.original, state.next);
      return {
        file: state.file,
        ...parseVerificationFields(verification),
      };
    } catch (error) {
      rethrowWithEditContext(error, undefined, state.file);
    }
  });

  const files = commitWorkspaceUpdates(
    [...states.values()].map((state) => ({ file: state.file, source: state.next })),
    options,
  );

  return { success: true, editCount: results.length, fileCount: states.size, results, parse, files };
}

function normalizeEdit(rawEdit: unknown, index: number): {
  file: string;
  strategy: BaseFindStrategy;
  mutation: BaseEditMutation;
  replaceAll: boolean;
  expectCount?: number;
} {
  if (!rawEdit || typeof rawEdit !== "object" || Array.isArray(rawEdit)) {
    fail("INVALID_MULTIEDIT", `Edit ${index}: edit must be an object.`);
  }
  const edit = rawEdit as Record<string, unknown>;
  if (edit.action !== undefined && edit.action !== "edit") {
    fail("INVALID_MULTIEDIT", `Edit ${index}: action must be omitted or "edit".`);
  }

  const file = stringValue(pick(edit, "file"), `Edit ${index}: file must be a non-empty string.`);
  const expectCountValue = pick(edit, "expectCount", "expect-count", "expect_count");
  const expectCount = expectCountValue === undefined ? undefined : Number(expectCountValue);
  if (expectCountValue !== undefined && !Number.isInteger(expectCount)) {
    fail("INVALID_MULTIEDIT", `Edit ${index}: expectCount must be an integer.`);
  }

  return {
    file,
    strategy: resolveStrategy(edit, index),
    mutation: resolveMutation(edit, index),
    replaceAll: booleanValue(pick(edit, "replaceAll", "replace-all", "replace_all")),
    ...(expectCountValue === undefined ? {} : { expectCount }),
  };
}

function resolveStrategy(edit: Record<string, unknown>, index: number): BaseFindStrategy {
  const find = pick(edit, "find");
  const findExact = pick(edit, "findExact", "find-exact", "find_exact");
  const findFuzzy = pick(edit, "findFuzzy", "find-fuzzy", "find_fuzzy");
  const findAnchorAfter = pick(edit, "findAnchorAfter", "find-anchor-after", "find_anchor_after");
  const findRegex = pick(edit, "findRegex", "find-regex", "find_regex");
  const findLines = pick(edit, "findLines", "find-lines", "find_lines");
  const explicitCount = [findExact, findFuzzy, findAnchorAfter, findRegex, findLines].filter((value) => value !== undefined).length;

  if (explicitCount > 1) fail("INVALID_MULTIEDIT", `Edit ${index}: accepts only one find strategy.`);
  if (find !== undefined && explicitCount > 0 && findAnchorAfter === undefined) {
    fail("INVALID_MULTIEDIT", `Edit ${index}: find is exact unless paired with findAnchorAfter.`);
  }

  if (findAnchorAfter !== undefined) {
    const contains = pick(edit, "contains", "find");
    if (contains === undefined) fail("INVALID_MULTIEDIT", `Edit ${index}: findAnchorAfter requires contains or find.`);
    return {
      kind: "anchor",
      after: stringValue(findAnchorAfter, `Edit ${index}: findAnchorAfter must be a string.`),
      contains: stringValue(contains, `Edit ${index}: contains/find must be a string.`),
    };
  }
  if (findExact !== undefined) {
    return { kind: "exact", pattern: stringValue(findExact, `Edit ${index}: findExact must be a string.`) };
  }
  if (findFuzzy !== undefined) {
    return { kind: "fuzzy", pattern: stringValue(findFuzzy, `Edit ${index}: findFuzzy must be a string.`), ignoreWhitespace: true };
  }
  if (findRegex !== undefined) {
    return {
      kind: "regex",
      pattern: stringValue(findRegex, `Edit ${index}: findRegex must be a string.`),
      ...(pick(edit, "flags") === undefined ? {} : { flags: String(pick(edit, "flags")) }),
    };
  }
  if (findLines !== undefined) {
    return { kind: "lines", ...parseLineRange(stringValue(findLines, `Edit ${index}: findLines must be a string.`)) };
  }
  if (find !== undefined) {
    return { kind: "exact", pattern: stringValue(find, `Edit ${index}: find must be a string.`) };
  }

  fail("INVALID_MULTIEDIT", `Edit ${index}: requires find, findExact, findFuzzy, findAnchorAfter, findRegex, or findLines.`);
}

function resolveMutation(edit: Record<string, unknown>, index: number): BaseEditMutation {
  const replace = pick(edit, "replace");
  const insertBefore = pick(edit, "insertBefore", "insert-before", "insert_before");
  const insertAfter = pick(edit, "insertAfter", "insert-after", "insert_after");
  const shouldDelete = booleanValue(pick(edit, "delete"));
  const count = [replace !== undefined, insertBefore !== undefined, insertAfter !== undefined, shouldDelete].filter(Boolean).length;

  if (count !== 1) {
    fail("INVALID_MULTIEDIT", `Edit ${index}: requires exactly one of replace, insertBefore, insertAfter, or delete.`);
  }
  if (replace !== undefined) return { kind: "replace", text: String(replace) };
  if (insertBefore !== undefined) return { kind: "insert-before", text: String(insertBefore) };
  if (insertAfter !== undefined) return { kind: "insert-after", text: String(insertAfter) };
  return { kind: "delete" };
}

function ensureState(states: Map<string, MultieditFileState>, file: string): MultieditFileState {
  const existing = states.get(file);
  if (existing) return existing;
  if (!existsSync(file)) fail("FILE_NOT_FOUND", `File not found: ${file}`);
  const original = readFileSync(file, "utf8");
  const state = { file, original, next: original };
  states.set(file, state);
  return state;
}

function rethrowWithEditContext(error: unknown, edit: number | undefined, file: string): never {
  if (error instanceof TeditError) {
    fail(error.code, error.message, {
      ...(edit === undefined ? {} : { edit }),
      file,
      ...(error.details === undefined ? {} : { cause: error.details }),
    });
  }
  throw error;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function stringValue(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_MULTIEDIT", message);
  return value;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
