import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import traverseModule, { type NodePath, type TraverseOptions } from "@babel/traverse";
import * as t from "@babel/types";
import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import { parseDocumentForFile } from "./core/registry.js";
import { fail } from "./errors.js";
import { analyzeState, loadQualityConfig } from "./quality.js";
import { JsxDocument } from "./rules/jsx/document.js";
import { matchesSimpleSelector, parseSelector, selectorHasScope, type ParsedSelector, type SelectorCombinator, type SimpleSelector } from "./rules/jsx/selector.js";

const traverseAst = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (
  parent: t.Node,
  opts: TraverseOptions,
) => void;
const nodeRequire = createRequire(import.meta.url);

type SourcePatch = {
  start: number;
  end: number;
  text: string;
};

type SourceRange = {
  start: number;
  end: number;
};

type IndexedNode = t.JSXElement | t.JSXFragment | t.JSXExpressionContainer;
type ContainerNode = t.JSXElement | t.JSXFragment;
type IndexedPath = NodePath<IndexedNode>;

export type ExtractSlotSpec = {
  selector: string;
  prop: string;
};

export type ExtractOptions = {
  from: string;
  selector: string;
  to: string;
  name: string;
  source?: string;
  destinationExists?: boolean;
  typecheck?: boolean;
  exportKind?: "named" | "default";
  slots?: string[];
  depth?: number;
  autoSlot?: boolean;
  helpersPolicy?: HelperPolicy;
  helperOverrides?: string[];
  overwrite?: boolean;
  maxProps?: number;
  acceptLargeProps?: boolean;
};

export type ExtractPropResult = {
  name: string;
  type: string;
  optional?: boolean;
  source: "free-variable" | "slot" | "helper-prop";
};

export type ExtractDiagnostic = {
  code: string;
  message: string;
  name?: string;
};

export type ExtractResult = {
  success: true;
  from: string;
  to: string;
  name: string;
  export: "named" | "default";
  props: ExtractPropResult[];
  imports: {
    transferred: Array<{ from: string; named?: string[]; default?: string; namespace?: string; type?: boolean }>;
    removed_from_source: Array<{ from: string; named?: string[]; default?: string; namespace?: string }>;
    added_to_source: Array<{ from: string; named?: string[]; default?: string }>;
  };
  helpers: HelperResult[];
  slots: Array<{ selector: string; prop: string }>;
  diagnostics: ExtractDiagnostic[];
  inference_mode: "annotation-only" | "with-checker" | "checker-unavailable";
};

export type HelperPolicy = "ask" | "move" | "share" | "as-prop";
export type HelperAction = "moved" | "shared-via-import" | "passed-as-prop" | "left";
export type HelperResult = {
    name: string;
    kind: string;
    class: "shell-only" | "shared" | "ambiguous";
    action: HelperAction;
    source_refs_remaining: number;
    import_added_to_new_file?: { from: string; named: string[] };
};

export type ExtractPlan = {
  result: ExtractResult;
  source: string;
  nextSource: string;
  newSource: string;
};

type ImportedBinding = {
  source: string;
  local: string;
  imported?: string;
  kind: "named" | "default" | "namespace";
  declaration: t.ImportDeclaration;
  specifier: t.ImportDeclaration["specifiers"][number];
};

type ImportSpec = ExtractResult["imports"]["transferred"][number];

type FileBinding = {
  name: string;
  kind: string;
  node: t.Statement;
  declaration: t.Statement | t.Declaration;
  exported: boolean;
};

type SlotPlan = ExtractSlotSpec & {
  content: string;
};

type HelperPlan = {
  result: HelperResult;
  binding?: FileBinding;
  sourcePatch?: SourcePatch;
  sourcePrefixPatch?: SourcePatch;
  movedSource?: string;
  importForNewFile?: { from: string; named: string[] };
  prop?: ExtractPropResult;
};

const GLOBAL_IDENTIFIERS = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "React",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "console",
  "undefined",
]);

export function parseExtractSlot(input: string): ExtractSlotSpec {
  const eq = findTopLevelEquals(input);
  const rawSelector = eq >= 0 ? input.slice(0, eq).trim() : input.trim();
  const prop = eq >= 0 ? input.slice(eq + 1).trim() : "children";
  const selector = rawSelector.endsWith(".children") ? rawSelector.slice(0, -".children".length) : rawSelector;

  if (!selector) fail("INVALID_EXTRACT", `Invalid slot selector: ${input}`);
  if (!/^[A-Za-z_$][\w$]*$/.test(prop)) fail("INVALID_EXTRACT", `Invalid slot prop name: ${prop}`);
  return { selector, prop };
}

export function planExtract(options: ExtractOptions): ExtractPlan {
  if (!/^[A-Z][A-Za-z0-9_$]*$/.test(options.name)) {
    fail("INVALID_EXTRACT", `Component name must be PascalCase: ${options.name}`);
  }
  const exportKind = options.exportKind ?? "named";
  if (exportKind !== "named" && exportKind !== "default") {
    fail("INVALID_EXTRACT", "--export must be named or default.");
  }
  const destinationExists = options.destinationExists ?? existsSync(options.to);
  if (destinationExists && !options.overwrite) {
    fail("EXTRACT_DESTINATION_EXISTS", `Refusing to overwrite existing file: ${options.to}. Use --overwrite to bypass.`);
  }

  const source = options.source ?? readFileSync(options.from, "utf8");
  const ast = recast.parse(source, { parser: babelTsParser }) as unknown as t.File;
  const targetPath = resolveExtractTarget(options.from, source, ast, options.selector);
  const targetNode = targetPath.node;
  if (!t.isJSXElement(targetNode) && !t.isJSXFragment(targetNode)) {
    fail("UNSUPPORTED_EXTRACT", "extract requires a JSX element or fragment target.");
  }
  const targetRange = nodeRange(source, targetNode);
  if (options.autoSlot && options.depth === undefined) {
    fail("INVALID_EXTRACT", "--auto-slot requires --depth.");
  }
  let rawSlots = options.slots ?? [];
  if (options.depth !== undefined && rawSlots.length === 0) {
    const suggestions = suggestSlotsAtDepth(targetNode, options.depth);
    if (options.autoSlot) {
      rawSlots = suggestions;
    } else {
      fail(
        "EXTRACT_SLOT_REQUIRED",
        `extract: --depth ${options.depth} specified but no --slot. Cannot determine slot boundary.`,
        { suggestedSlots: suggestions },
      );
    }
  }

  const importBindings = collectImportBindings(ast);
  const fileBindings = collectFileBindings(ast);
  const shellNode = t.cloneNode(targetNode, true) as ContainerNode;
  const slotSpecs = rawSlots.map(parseExtractSlot);
  const slotPlans = applySlotsToShell(source, targetNode, shellNode, slotSpecs);
  const slotPropNames = new Set(slotPlans.map((slot) => slot.prop));
  if (slotPropNames.size !== slotPlans.length) {
    fail("INVALID_EXTRACT", "Slot prop names must be unique.");
  }

  const references = collectExternalReferences(shellNode);
  const checkerInference = options.typecheck
    ? inferReferencePropTypesWithTypeScript(options.from, source, targetNode, references)
    : { mode: "annotation-only" as const, types: new Map<string, InferredPropType>() };
  const usedImports: ImportedBinding[] = [];
  const freeProps: ExtractPropResult[] = [];
  const helperPlans: HelperPlan[] = [];
  const diagnostics: ExtractDiagnostic[] = [];
  const helperOverrides = parseHelperOverrides(options.helperOverrides ?? []);
  const helperPolicy = options.helpersPolicy ?? "ask";
  const extractionRanges: SourceRange[] = [targetRange];
  const helperPlanByName = new Map<string, HelperPlan>();

  for (const name of references) {
    if (slotPropNames.has(name) || GLOBAL_IDENTIFIERS.has(name)) continue;
    const imported = importBindings.get(name);
    if (imported) {
      usedImports.push(imported);
      continue;
    }
    const fileBinding = fileBindings.get(name);
    if (fileBinding) {
      const helperPlan = planHelper({
        source,
        ast,
        binding: fileBinding,
        fromFile: options.from,
        toFile: options.to,
        extractionRanges,
        policy: helperPolicy,
        override: helperOverrides.get(name),
      });
      helperPlans.push(helperPlan);
      helperPlanByName.set(name, helperPlan);
      if (helperPlan.binding && helperPlan.result.action === "moved") extractionRanges.push(nodeRange(source, helperPlan.binding.node));
      if (helperPlan.prop) freeProps.push(helperPlan.prop);
      if (helperPlan.result.action === "passed-as-prop") {
        diagnostics.push({
          code: "HELPER_PASSED_AS_PROP",
          name,
          message: `File-level helper "${name}" is passed as a prop by explicit extract helper policy.`,
        });
      }
      continue;
    }
    const astInferredType = inferReferencePropType(ast, targetPath, name);
    freeProps.push({
      name,
      ...(astInferredType.type === "unknown" ? checkerInference.types.get(name) ?? astInferredType : astInferredType),
      source: "free-variable",
    });
  }
  expandMovedHelperClosure({
    source,
    ast,
    fileBindings,
    importBindings,
    usedImports,
    helperPlans,
    helperPlanByName,
    extractionRanges,
    fromFile: options.from,
    toFile: options.to,
    policy: helperPolicy,
    overrides: helperOverrides,
    slotPropNames,
  });
  failOnSharedHelperCycles(helperPlans);

  const slotProps = slotPlans.map<ExtractPropResult>((slot) => ({ name: slot.prop, type: "ReactNode", source: "slot" }));
  const props = [...freeProps, ...slotProps];
  enforceExtractPropsGuardrail(options, source, props);
  const transferredImports = summarizeImports(dedupeImports(usedImports));
  const propTypeImports = planPropTypeImports({
    source,
    props,
    importBindings,
    fileBindings,
    fromFile: options.from,
    toFile: options.to,
  });
  const helperImports = helperPlans.flatMap((plan) => plan.importForNewFile ?? []);
  const newSource = buildExtractedSource({
    name: options.name,
    exportKind,
    shellNode,
    props,
    imports: [...transferredImports, ...helperImports, ...propTypeImports.imports],
    movedHelpers: helperPlans
      .filter((plan): plan is HelperPlan & { binding: FileBinding; movedSource: string } => !!plan.binding && !!plan.movedSource)
      .sort((a, b) => nodeRange(source, a.binding.node).start - nodeRange(source, b.binding.node).start)
      .map((plan) => plan.movedSource),
    needsReactNode: slotProps.length > 0,
  });
  parseDocumentForFile(options.to, newSource);

  const sourceImport = buildSourceComponentImport(options.from, options.to, options.name, exportKind);
  const removedImports = planUnusedImportRemoval(source, ast, dedupeImports(usedImports), extractionRanges);
  const sourceTransformPatches = [
    ...helperPlans.flatMap((plan) => [plan.sourcePatch, plan.sourcePrefixPatch].filter((patch): patch is SourcePatch => !!patch)),
    ...propTypeImports.sourcePatches,
    ...removedImports.patches,
    { start: targetRange.start, end: targetRange.end, text: buildCallSite(options.name, freeProps, slotPlans) },
  ];
  const transformedSource = applySourcePatches(source, sourceTransformPatches);
  const transformedAst = recast.parse(transformedSource, { parser: babelTsParser }) as unknown as t.File;
  const nextSource = applySourcePatches(transformedSource, [buildAddImportPatch(transformedSource, transformedAst, sourceImport)]);
  parseDocumentForFile(options.from, nextSource);

  return {
    source,
    nextSource,
    newSource,
    result: {
      success: true,
      from: options.from,
      to: options.to,
      name: options.name,
      export: exportKind,
      props,
      imports: {
        transferred: transferredImports,
        removed_from_source: summarizeImports(removedImports.removed),
        added_to_source: [sourceImport],
      },
      helpers: helperPlans.map((plan) => plan.result),
      slots: slotPlans.map(({ selector, prop }) => ({ selector, prop })),
      diagnostics,
      inference_mode: checkerInference.mode,
    },
  };
}

function enforceExtractPropsGuardrail(options: ExtractOptions, source: string, props: ExtractPropResult[]): void {
  const maxProps = options.maxProps ?? loadQualityConfig(options.from).maxExtractProps;
  if (props.length <= maxProps || options.acceptLargeProps) return;

  const analysis = analyzeState(options.from, source);
  fail(
    "EXTRACT_PROPS_OVERFLOW",
    `extract: predicted ${props.length} props on ${options.name}; max is ${maxProps}.`,
    {
      props_count: props.length,
      max_props: maxProps,
      props: props.map((prop) => ({ name: prop.name, source: prop.source, type: prop.type })),
      clusters: analysis.clusters,
      ungrouped: analysis.ungrouped,
      options: [
        "--accept-large-props",
        "--max-props=N",
        "run: tedit analyze-state <file>",
      ],
      next_step_hint: "Refactor state first, choose explicit slots, or pass --accept-large-props to extract as-is.",
    },
  );
}

function resolveExtractTarget(filePath: string, source: string, ast: t.File, selector: string): IndexedPath {
  const doc = new JsxDocument(filePath, source);
  const matches = doc.find(selector);
  if (matches.length === 0) fail("NODE_NOT_FOUND", `No JSX node matched "${selector}".`);
  if (matches.length > 1) {
    fail("AMBIGUOUS_SELECTOR", `Selector "${selector}" matched ${matches.length} nodes. Use a narrower selector.`, {
      matches: matches.map(({ id, name, loc, preview }) => ({ id, name, loc, preview })),
    });
  }

  const loc = matches[0].loc;
  if (!loc) fail("UNSUPPORTED_EXTRACT", "extract target is missing source locations.");

  let found: IndexedPath | null = null;
  traverseAst(ast, {
    JSXElement(path) {
      if (sameLoc(path.node, loc)) {
        found = path;
        path.stop();
      }
    },
    JSXFragment(path) {
      if (sameLoc(path.node, loc)) {
        found = path;
        path.stop();
      }
    },
    JSXExpressionContainer(path) {
      if (sameLoc(path.node, loc)) {
        found = path;
        path.stop();
      }
    },
  });

  if (!found) fail("NODE_NOT_FOUND", `Matched node for "${selector}" could not be resolved in the AST.`);
  return found;
}

function sameLoc(node: t.Node, loc: NonNullable<ReturnType<JsxDocument["inspect"]>["loc"]>): boolean {
  return !!node.loc &&
    node.loc.start.line === loc.start.line &&
    node.loc.start.column === loc.start.column &&
    node.loc.end.line === loc.end.line &&
    node.loc.end.column === loc.end.column;
}

function applySlotsToShell(source: string, originalNode: ContainerNode, shellNode: ContainerNode, specs: ExtractSlotSpec[]): SlotPlan[] {
  const slots: SlotPlan[] = [];

  for (const spec of specs) {
    const originalMatches = findMatchingPaths(originalNode, spec.selector).filter((path): path is NodePath<ContainerNode> => {
      return path.isJSXElement() || path.isJSXFragment();
    });
    const shellMatches = findMatchingPaths(shellNode, spec.selector).filter((path): path is NodePath<ContainerNode> => {
      return path.isJSXElement() || path.isJSXFragment();
    });
    if (originalMatches.length === 0) fail("NODE_NOT_FOUND", `Slot selector "${spec.selector}" matched no nodes inside the extracted subtree.`);
    if (originalMatches.length > 1) fail("AMBIGUOUS_SELECTOR", `Slot selector "${spec.selector}" matched ${originalMatches.length} nodes inside the extracted subtree.`);
    if (shellMatches.length !== originalMatches.length) fail("UNSUPPORTED_EXTRACT", `Slot selector "${spec.selector}" could not be mapped into the extracted shell.`);

    const path = shellMatches[0];
    const content = getChildrenSource(source, originalMatches[0].node);
    path.node.children = [t.jsxExpressionContainer(t.identifier(spec.prop))];
    if (path.isJSXElement()) {
      path.node.openingElement.selfClosing = false;
      path.node.closingElement ??= t.jsxClosingElement(t.cloneNode(path.node.openingElement.name, true));
    }
    slots.push({ ...spec, content });
  }

  return slots;
}

function suggestSlotsAtDepth(root: ContainerNode, depth: number): string[] {
  if (depth < 0) fail("INVALID_EXTRACT", "--depth must be zero or greater.");
  const suggestions: string[] = [];

  const visit = (node: ContainerNode, currentDepth: number): void => {
    if (currentDepth === depth) {
      if (t.isJSXElement(node)) {
        const name = jsxNameToString(node.openingElement.name);
        suggestions.push(`${name}.children=${defaultSlotPropName(name)}`);
      } else {
        suggestions.push("Fragment.children=children");
      }
      return;
    }
    for (const child of node.children) {
      if (t.isJSXElement(child) || t.isJSXFragment(child)) visit(child, currentDepth + 1);
    }
  };

  if (depth === 0) return [t.isJSXElement(root) ? `${jsxNameToString(root.openingElement.name)}.children=children` : "Fragment.children=children"];
  for (const child of root.children) {
    if (t.isJSXElement(child) || t.isJSXFragment(child)) visit(child, 1);
  }
  return suggestions;
}

function defaultSlotPropName(name: string): string {
  const last = name.split(".").at(-1) ?? name;
  if (/header/i.test(last)) return "header";
  if (/body|content|children/i.test(last)) return "children";
  if (/footer/i.test(last)) return "footer";
  if (/actions?/i.test(last)) return "actions";
  return lowerCamel(last);
}

function lowerCamel(value: string): string {
  return value
    .replace(/^[^A-Za-z_$]+/, "")
    .replace(/^[A-Z]/, (char) => char.toLowerCase()) || "children";
}

type SelectorMatchContext = {
  allPaths: IndexedPath[];
  pathsByNode: WeakMap<object, IndexedPath>;
};

function findMatchingPaths(root: ContainerNode, selectorInput: string): IndexedPath[] {
  const selector = parseSelector(selectorInput);
  const ast = t.file(t.program([t.expressionStatement(root as t.Expression)]));
  const context: SelectorMatchContext = { allPaths: [], pathsByNode: new WeakMap<object, IndexedPath>() };

  traverseAst(ast, {
    JSXElement(path) {
      context.allPaths.push(path);
      context.pathsByNode.set(path.node, path);
    },
    JSXFragment(path) {
      context.allPaths.push(path);
      context.pathsByNode.set(path.node, path);
    },
    JSXExpressionContainer(path) {
      context.allPaths.push(path);
      context.pathsByNode.set(path.node, path);
    },
  });

  return context.allPaths.filter((path) => matchesSelectorPath(path, selector, context));
}

function matchesSelectorPath(path: IndexedPath, selector: ParsedSelector, context: SelectorMatchContext, partIndex = selector.parts.length - 1): boolean {
  const part = selector.parts[partIndex];
  if (!matchesSimplePath(path, part.selector, context)) return false;
  if (partIndex === 0) return true;

  return matchesPriorSelectorPart(path, selector, context, partIndex - 1, part.combinator ?? "descendant");
}

function matchesSimplePath(path: IndexedPath, selector: SimpleSelector, context: SelectorMatchContext, scope?: IndexedPath): boolean {
  if (!matchesSimpleSelector(buildInfo(path), selector)) return false;

  for (const pseudo of selector.pseudos) {
    if (pseudo.kind === "expr") continue;
    if (pseudo.kind === "scope" && (!scope || path.node !== scope.node)) return false;
    if (pseudo.kind === "has" && !hasRelativeMatch(path, pseudo.selector, context)) return false;
    if (pseudo.kind === "not" && matchesSelectorPath(path, pseudo.selector, context)) return false;
    if (pseudo.kind === "first-child" && !matchesChildPosition(path, "first")) return false;
    if (pseudo.kind === "last-child" && !matchesChildPosition(path, "last")) return false;
    if (pseudo.kind === "nth-of-type" && !matchesNthOfType(path, pseudo.index)) return false;
  }

  return true;
}

function matchesPriorSelectorPart(path: IndexedPath, selector: ParsedSelector, context: SelectorMatchContext, partIndex: number, combinator: SelectorCombinator): boolean {
  if (combinator === "child") {
    const parent = findNearestIndexedAncestor(path);
    return !!parent && matchesSelectorPath(parent, selector, context, partIndex);
  }

  if (combinator === "adjacent") {
    const previous = previousIndexedSiblingPath(path, context);
    return !!previous && matchesSelectorPath(previous, selector, context, partIndex);
  }

  if (combinator === "sibling") {
    return previousIndexedSiblingPaths(path, context).some((sibling) => matchesSelectorPath(sibling, selector, context, partIndex));
  }

  let ancestor = findNearestIndexedAncestor(path);
  while (ancestor) {
    if (matchesSelectorPath(ancestor, selector, context, partIndex)) return true;
    ancestor = findNearestIndexedAncestor(ancestor);
  }
  return false;
}

function hasRelativeMatch(scope: IndexedPath, selector: ParsedSelector, context: SelectorMatchContext): boolean {
  return context.allPaths.some((candidate) => matchesRelativeSelectorPath(scope, candidate, selector, context));
}

function matchesRelativeSelectorPath(scope: IndexedPath, path: IndexedPath, selector: ParsedSelector, context: SelectorMatchContext, partIndex = selector.parts.length - 1): boolean {
  const part = selector.parts[partIndex];
  if (!matchesSimplePath(path, part.selector, context, scope)) return false;
  if (partIndex === 0) return matchesScopedFirstPart(scope, path, part.combinator, part.selector, context);

  return matchesPriorRelativeSelectorPart(scope, path, selector, context, partIndex - 1, part.combinator ?? "descendant");
}

function matchesPriorRelativeSelectorPart(scope: IndexedPath, path: IndexedPath, selector: ParsedSelector, context: SelectorMatchContext, partIndex: number, combinator: SelectorCombinator): boolean {
  if (combinator === "child") {
    const parent = findNearestIndexedAncestor(path);
    return !!parent && matchesRelativeSelectorPath(scope, parent, selector, context, partIndex);
  }

  if (combinator === "adjacent") {
    const previous = previousIndexedSiblingPath(path, context);
    return !!previous && matchesRelativeSelectorPath(scope, previous, selector, context, partIndex);
  }

  if (combinator === "sibling") {
    return previousIndexedSiblingPaths(path, context).some((sibling) => matchesRelativeSelectorPath(scope, sibling, selector, context, partIndex));
  }

  let ancestor = findNearestIndexedAncestor(path);
  while (ancestor) {
    if (matchesRelativeSelectorPath(scope, ancestor, selector, context, partIndex)) return true;
    ancestor = findNearestIndexedAncestor(ancestor);
  }
  return false;
}

function matchesScopedFirstPart(scope: IndexedPath, path: IndexedPath, combinator: SelectorCombinator | undefined, selector: SimpleSelector, context: SelectorMatchContext): boolean {
  if (combinator === "child") {
    const parent = findNearestIndexedAncestor(path);
    return !!parent && parent.node === scope.node;
  }

  if (combinator === "adjacent") {
    const previous = previousIndexedSiblingPath(path, context);
    return !!previous && previous.node === scope.node;
  }

  if (combinator === "sibling") {
    return previousIndexedSiblingPaths(path, context).some((sibling) => sibling.node === scope.node);
  }

  if (selectorHasScope(selector)) return path.node === scope.node;
  return isIndexedDescendantOf(path, scope);
}

function isIndexedDescendantOf(path: IndexedPath, scope: IndexedPath): boolean {
  let ancestor = findNearestIndexedAncestor(path);
  while (ancestor) {
    if (ancestor.node === scope.node) return true;
    ancestor = findNearestIndexedAncestor(ancestor);
  }
  return false;
}

function previousIndexedSiblingPath(path: IndexedPath, context: SelectorMatchContext): IndexedPath | null {
  const previous = findPreviousIndexedSibling(path);
  return previous ? context.pathsByNode.get(previous) ?? null : null;
}

function previousIndexedSiblingPaths(path: IndexedPath, context: SelectorMatchContext): IndexedPath[] {
  return findPreviousIndexedSiblings(path)
    .map((sibling) => context.pathsByNode.get(sibling) ?? null)
    .filter((sibling): sibling is IndexedPath => !!sibling);
}

function buildInfo(path: IndexedPath): {
  id: string;
  kind: string;
  name: string;
  attributes: Record<string, unknown>;
  childCount: number;
  preview: string;
} {
  const node = path.node;
  const kind = t.isJSXElement(node) ? "element" : t.isJSXFragment(node) ? "fragment" : "expression";
  const name = t.isJSXElement(node) ? jsxNameToString(node.openingElement.name) : t.isJSXFragment(node) ? "Fragment" : "Expression";
  return {
    id: "",
    kind,
    name,
    attributes: t.isJSXElement(node) ? extractProps(node.openingElement.attributes) : {},
    childCount: t.isJSXElement(node) || t.isJSXFragment(node) ? node.children.filter((child) => !isWhitespaceText(child)).length : 0,
    preview: "",
  };
}

function matchesChildPosition(path: IndexedPath, position: "first" | "last"): boolean {
  const siblings = findDirectJsxSiblings(path);
  if (!siblings) return false;
  const index = siblings.findIndex((node) => node === path.node);
  if (index < 0) return false;
  return position === "first" ? index === 0 : index === siblings.length - 1;
}

function matchesNthOfType(path: IndexedPath, index: number): boolean {
  const info = buildInfo(path);
  const siblings = findDirectJsxSiblings(path);
  if (!siblings) return false;
  const sameType = siblings.filter((node) => {
    if (t.isJSXElement(node)) return jsxNameToString(node.openingElement.name) === info.name;
    if (t.isJSXFragment(node)) return info.name === "Fragment";
    return info.name === "Expression";
  });
  return sameType[index - 1] === path.node;
}

function findNearestIndexedAncestor(path: NodePath<t.Node>): IndexedPath | null {
  let current = path.parentPath;
  while (current) {
    if (current.isJSXElement() || current.isJSXFragment() || current.isJSXExpressionContainer()) return current as IndexedPath;
    current = current.parentPath;
  }
  return null;
}

function findNearestJsxContainerAncestor(path: NodePath<t.Node>): NodePath<ContainerNode> | null {
  let current = path.parentPath;
  while (current) {
    if (current.isJSXElement() || current.isJSXFragment()) return current as NodePath<ContainerNode>;
    current = current.parentPath;
  }
  return null;
}

function findDirectJsxSiblings(path: IndexedPath): IndexedNode[] | null {
  const parent = findNearestJsxContainerAncestor(path);
  if (!parent) return null;
  const siblings = flattenJsxChildren(parent.node.children);
  return siblings.some((child) => child === path.node) ? siblings : null;
}

function findPreviousIndexedSibling(path: IndexedPath): IndexedNode | null {
  return findPreviousIndexedSiblings(path)[0] ?? null;
}

function findPreviousIndexedSiblings(path: IndexedPath): IndexedNode[] {
  const siblings = findDirectJsxSiblings(path);
  if (!siblings) return [];
  const index = siblings.findIndex((node) => node === path.node);
  if (index <= 0) return [];
  return siblings.slice(0, index).reverse();
}

function flattenJsxChildren(children: ContainerNode["children"]): IndexedNode[] {
  const result: IndexedNode[] = [];
  for (const child of children) {
    if (isWhitespaceText(child)) continue;
    if (t.isJSXFragment(child)) result.push(...flattenJsxChildren(child.children));
    else if (isIndexableNode(child)) result.push(child);
  }
  return result;
}

function getChildrenSource(source: string, node: ContainerNode): string {
  if (t.isJSXElement(node)) {
    if (node.openingElement.selfClosing) return "";
    const open = nodeSourceRange(source, node.openingElement);
    const close = node.closingElement ? nodeSourceRange(source, node.closingElement) : null;
    if (!open || !close) {
      fail("UNSUPPORTED_EXTRACT", "Slot node is missing child source positions.");
    }
    return source.slice(open.end, close.start);
  }
  const open = nodeSourceRange(source, node.openingFragment);
  const close = nodeSourceRange(source, node.closingFragment);
  if (!open || !close) {
    fail("UNSUPPORTED_EXTRACT", "Slot fragment is missing child source positions.");
  }
  return source.slice(open.end, close.start);
}

function collectExternalReferences(root: ContainerNode): string[] {
  const ast = t.file(t.program([t.expressionStatement(root as t.Expression)]));
  const names: string[] = [];
  const seen = new Set<string>();

  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  traverseAst(ast, {
    JSXElement(path) {
      const name = jsxNameBase(path.node.openingElement.name);
      if (name && /^[A-Z]/.test(name)) add(name);
    },
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const name = path.node.name;
      if (path.scope.hasBinding(name)) return;
      add(name);
    },
  });

  return names;
}

function collectImportBindings(ast: t.File): Map<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();
  for (const statement of ast.program.body) {
    if (!t.isImportDeclaration(statement)) continue;
    for (const specifier of statement.specifiers) {
      if (t.isImportSpecifier(specifier)) {
        bindings.set(specifier.local.name, {
          source: statement.source.value,
          local: specifier.local.name,
          imported: importedNameToString(specifier.imported),
          kind: "named",
          declaration: statement,
          specifier,
        });
      } else if (t.isImportDefaultSpecifier(specifier)) {
        bindings.set(specifier.local.name, {
          source: statement.source.value,
          local: specifier.local.name,
          kind: "default",
          declaration: statement,
          specifier,
        });
      } else if (t.isImportNamespaceSpecifier(specifier)) {
        bindings.set(specifier.local.name, {
          source: statement.source.value,
          local: specifier.local.name,
          kind: "namespace",
          declaration: statement,
          specifier,
        });
      }
    }
  }
  return bindings;
}

function collectFileBindings(ast: t.File): Map<string, FileBinding> {
  const bindings = new Map<string, FileBinding>();
  for (const statement of ast.program.body) {
    if (t.isExportNamedDeclaration(statement) && statement.declaration) {
      collectDeclarationBindings(bindings, statement, statement.declaration, true);
    } else if (!t.isExportDefaultDeclaration(statement)) {
      collectDeclarationBindings(bindings, statement, statement, false);
    }
  }
  return bindings;
}

type InferredPropType = {
  type: string;
  optional?: boolean;
};

type TypeScriptModule = typeof import("typescript");

let cachedTypeScript: TypeScriptModule | null | undefined;

function inferReferencePropTypesWithTypeScript(
  filePath: string,
  source: string,
  root: ContainerNode,
  names: string[],
): {
  mode: ExtractResult["inference_mode"];
  types: Map<string, InferredPropType>;
} {
  const ts = loadTypeScript();
  const result = new Map<string, InferredPropType>();
  if (!ts) return { mode: "checker-unavailable", types: result };
  if (names.length === 0) return { mode: "with-checker", types: result };
  const rootRange = nodeSourceRange(source, root);
  if (!rootRange) return { mode: "with-checker", types: result };

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindForFile(ts, filePath));
  const options = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    noResolve: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  };
  const host = createSingleFileCompilerHost(ts, filePath, sourceFile, options);
  const program = ts.createProgram({
    rootNames: [filePath],
    options,
    host,
  });
  const checker = program.getTypeChecker();
  const candidates = new Set(names);

  const visit = (node: import("typescript").Node): void => {
    if (
      ts.isIdentifier(node) &&
      candidates.has(node.text) &&
      node.getStart(sourceFile) >= rootRange.start &&
      node.getEnd() <= rootRange.end &&
      isTypeScriptValueReference(ts, node) &&
      !result.has(node.text)
    ) {
      const inferred = typeFromTypeChecker(ts, checker, node);
      if (inferred) result.set(node.text, inferred);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { mode: "with-checker", types: result };
}

function loadTypeScript(): TypeScriptModule | null {
  if (cachedTypeScript !== undefined) return cachedTypeScript;
  try {
    cachedTypeScript = nodeRequire("typescript") as TypeScriptModule;
  } catch {
    cachedTypeScript = null;
  }
  return cachedTypeScript;
}

function scriptKindForFile(ts: TypeScriptModule, filePath: string): import("typescript").ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.ts$/i.test(filePath)) return ts.ScriptKind.TS;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function createSingleFileCompilerHost(
  ts: TypeScriptModule,
  filePath: string,
  sourceFile: import("typescript").SourceFile,
  options: import("typescript").CompilerOptions,
): import("typescript").CompilerHost {
  const defaultHost = ts.createCompilerHost(options);
  const canonicalFileName = (name: string): string => {
    const normalized = name.replace(/\\/g, "/");
    return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
  };
  const canonical = canonicalFileName(filePath);
  const sameFile = (candidate: string): boolean => canonicalFileName(candidate) === canonical;

  return {
    ...defaultHost,
    getSourceFile: (requested, languageVersion, onError, shouldCreateNewSourceFile) => {
      return sameFile(requested)
        ? sourceFile
        : defaultHost.getSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile);
    },
    writeFile: () => undefined,
    getCurrentDirectory: () => dirname(filePath) || defaultHost.getCurrentDirectory(),
    fileExists: (requested) => sameFile(requested) || defaultHost.fileExists(requested),
    readFile: (requested) => sameFile(requested) ? sourceFile.text : defaultHost.readFile(requested),
    getCanonicalFileName: canonicalFileName,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
  };
}

function typeFromTypeChecker(
  ts: TypeScriptModule,
  checker: import("typescript").TypeChecker,
  node: import("typescript").Identifier,
): InferredPropType | null {
  const type = checker.getTypeAtLocation(node);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return null;

  const code = checker.typeToString(
    type,
    node,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
  if (!code || code === "any" || code === "unknown" || code === "never") return null;
  return { type: code };
}

function isTypeScriptValueReference(ts: TypeScriptModule, node: import("typescript").Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return false;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  return true;
}

function inferReferencePropType(ast: t.File, scopePath: NodePath<t.Node>, name: string): InferredPropType {
  const binding = scopePath.scope.getBinding(name);
  if (!binding) return { type: "unknown" };
  return inferBindingPathType(ast, binding.path as NodePath<t.Node>, name) ?? { type: "unknown" };
}

function inferBindingPathType(ast: t.File, path: NodePath<t.Node>, name: string): InferredPropType | null {
  if (path.isObjectPattern()) {
    const property = path.node.properties.find((prop): prop is t.ObjectProperty => {
      return t.isObjectProperty(prop) && bindingNames(prop.value as t.LVal).includes(name);
    });
    const key = property ? objectPropertyKeyName(property) : null;
    return key ? lookupObjectPatternPropertyType(ast, path.node, key) : null;
  }

  if (path.isIdentifier()) {
    const direct = inferIdentifierType(path.node);
    if (direct) return direct;

    const parent = path.parentPath;
    if (parent?.isObjectProperty() && parent.parentPath?.isObjectPattern()) {
      const key = objectPropertyKeyName(parent.node);
      if (key) return lookupObjectPatternPropertyType(ast, parent.parentPath.node, key);
    }

    if (parent?.isVariableDeclarator()) {
      const variableType = inferVariableDeclaratorType(parent.node, name);
      if (variableType) return variableType;
    }

    if (parent?.isArrayPattern() && parent.parentPath?.isVariableDeclarator()) {
      const stateType = inferUseStateTupleBindingType(parent.parentPath.node, path.node.name);
      if (stateType) return stateType;
    }

    if (parent?.isFunctionDeclaration() && parent.node.id === path.node) {
      return inferFunctionLikeType(parent.node);
    }
  }

  if (path.isFunctionDeclaration() && path.node.id?.name === name) {
    return inferFunctionLikeType(path.node);
  }

  if (path.isVariableDeclarator()) {
    return inferVariableDeclaratorType(path.node, name);
  }

  return null;
}

function inferIdentifierType(node: t.Identifier): InferredPropType | null {
  const annotation = node.typeAnnotation;
  if (!annotation || !t.isTSTypeAnnotation(annotation)) return null;
  return { type: printNodeCode(annotation.typeAnnotation) };
}

function inferVariableDeclaratorType(node: t.VariableDeclarator, name?: string): InferredPropType | null {
  if (t.isIdentifier(node.id)) {
    const direct = inferIdentifierType(node.id);
    if (direct) return direct;
  }
  if (name && t.isArrayPattern(node.id)) {
    const tupleType = inferUseStateTupleBindingType(node, name);
    if (tupleType) return tupleType;
  }
  if (!node.init) return null;
  if (t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init)) {
    return inferFunctionLikeType(node.init);
  }
  return inferExpressionType(node.init);
}

function inferExpressionType(node: t.Expression): InferredPropType | null {
  if (t.isStringLiteral(node)) return { type: "string" };
  if (t.isNumericLiteral(node)) return { type: "number" };
  if (t.isBooleanLiteral(node)) return { type: "boolean" };
  if (t.isNullLiteral(node)) return { type: "null" };
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return { type: "string" };
  if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node)) return { type: printNodeCode(node.typeAnnotation) };
  if (t.isArrayExpression(node)) return inferArrayExpressionType(node);
  if (t.isObjectExpression(node)) return inferObjectExpressionType(node);
  return null;
}

function inferArrayExpressionType(node: t.ArrayExpression): InferredPropType | null {
  if (node.elements.length === 0) return { type: "unknown[]" };
  const elementTypes: string[] = [];
  for (const element of node.elements) {
    if (!element) {
      elementTypes.push("undefined");
      continue;
    }
    if (t.isSpreadElement(element)) return null;
    const inferred = inferExpressionType(element);
    elementTypes.push(inferred?.type ?? "unknown");
  }
  const union = uniqueTypes(elementTypes).join(" | ");
  return { type: union.includes(" | ") ? `(${union})[]` : `${union}[]` };
}

function inferObjectExpressionType(node: t.ObjectExpression): InferredPropType | null {
  if (node.properties.length > 8) return null;
  const members: string[] = [];
  for (const property of node.properties) {
    if (!t.isObjectProperty(property) || property.computed) return null;
    const key = typeMemberKeyName(property.key);
    if (!key || !t.isExpression(property.value)) return null;
    const inferred = inferExpressionType(property.value);
    members.push(`${key}: ${inferred?.type ?? "unknown"}`);
  }
  return { type: `{ ${members.join("; ")} }` };
}

function inferUseStateTupleBindingType(node: t.VariableDeclarator, name: string): InferredPropType | null {
  if (!t.isArrayPattern(node.id) || !node.init || !t.isCallExpression(node.init) || !isUseStateCallee(node.init.callee)) return null;
  const [stateNode, setterNode] = node.id.elements;
  const stateType = inferUseStateValueType(node.init);
  if (!stateType) return null;
  if (t.isIdentifier(stateNode) && stateNode.name === name) return { type: stateType };
  if (t.isIdentifier(setterNode) && setterNode.name === name) {
    return { type: `(value: ${stateType} | ((previous: ${stateType}) => ${stateType})) => void` };
  }
  return null;
}

function inferUseStateValueType(node: t.CallExpression): string | null {
  const typeParameters = (node as t.CallExpression & { typeParameters?: t.TSTypeParameterInstantiation; typeArguments?: t.TSTypeParameterInstantiation }).typeParameters
    ?? (node as t.CallExpression & { typeParameters?: t.TSTypeParameterInstantiation; typeArguments?: t.TSTypeParameterInstantiation }).typeArguments;
  const explicit = typeParameters?.params[0];
  if (explicit) return printNodeCode(explicit);
  const [initial] = node.arguments;
  if (initial && t.isExpression(initial)) return inferExpressionType(initial)?.type ?? null;
  return null;
}

function isUseStateCallee(node: t.CallExpression["callee"]): boolean {
  if (t.isIdentifier(node)) return node.name === "useState";
  return t.isMemberExpression(node) &&
    t.isIdentifier(node.object, { name: "React" }) &&
    t.isIdentifier(node.property, { name: "useState" });
}

function uniqueTypes(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function lookupObjectPatternPropertyType(ast: t.File, pattern: t.ObjectPattern, propName: string): InferredPropType | null {
  const annotation = pattern.typeAnnotation;
  if (!annotation || !t.isTSTypeAnnotation(annotation)) return null;
  return lookupPropertyType(ast, annotation.typeAnnotation, propName);
}

function lookupPropertyType(ast: t.File, typeNode: t.TSType, propName: string): InferredPropType | null {
  if (t.isTSTypeLiteral(typeNode)) return lookupTypeMembers(ast, typeNode.members, propName);
  if (t.isTSIntersectionType(typeNode)) {
    for (const child of typeNode.types) {
      const found = lookupPropertyType(ast, child, propName);
      if (found) return found;
    }
    return null;
  }
  if (t.isTSParenthesizedType(typeNode)) return lookupPropertyType(ast, typeNode.typeAnnotation, propName);
  if (t.isTSTypeReference(typeNode) && t.isIdentifier(typeNode.typeName)) {
    const declaration = findTypeDeclaration(ast, typeNode.typeName.name);
    if (!declaration) return null;
    if (t.isTSInterfaceDeclaration(declaration)) return lookupTypeMembers(ast, declaration.body.body, propName);
    if (t.isTSTypeAliasDeclaration(declaration)) return lookupPropertyType(ast, declaration.typeAnnotation, propName);
  }
  return null;
}

function lookupTypeMembers(ast: t.File, members: t.TSTypeElement[], propName: string): InferredPropType | null {
  for (const member of members) {
    if (t.isTSPropertySignature(member)) {
      if (typeMemberKeyName(member.key) !== propName || !member.typeAnnotation) continue;
      return { type: printNodeCode(member.typeAnnotation.typeAnnotation), ...(member.optional ? { optional: true } : {}) };
    }
    if (t.isTSMethodSignature(member)) {
      if (typeMemberKeyName(member.key) !== propName) continue;
      const returnType = member.typeAnnotation ? printNodeCode(member.typeAnnotation.typeAnnotation) : "unknown";
      return {
        type: `(${member.parameters.map(formatFunctionParam).join(", ")}) => ${returnType}`,
        ...(member.optional ? { optional: true } : {}),
      };
    }
  }
  return null;
}

function findTypeDeclaration(ast: t.File, name: string): t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration | null {
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (t.isTSInterfaceDeclaration(declaration) && declaration.id.name === name) return declaration;
    if (t.isTSTypeAliasDeclaration(declaration) && declaration.id.name === name) return declaration;
  }
  return null;
}

function inferFunctionLikeType(node: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression): InferredPropType | null {
  const hasAnnotation = node.params.some(hasParamTypeAnnotation) || !!node.returnType;
  if (!hasAnnotation) return null;
  const returnType = node.returnType && t.isTSTypeAnnotation(node.returnType)
    ? printNodeCode(node.returnType.typeAnnotation)
    : "unknown";
  return { type: `(${node.params.map(formatFunctionParam).join(", ")}) => ${returnType}` };
}

function hasParamTypeAnnotation(param: t.FunctionDeclaration["params"][number]): boolean {
  if (t.isIdentifier(param)) return !!param.typeAnnotation;
  if (t.isRestElement(param) && t.isIdentifier(param.argument)) return !!param.argument.typeAnnotation;
  if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) return !!param.left.typeAnnotation;
  return false;
}

function formatFunctionParam(param: t.FunctionDeclaration["params"][number] | t.TSMethodSignature["parameters"][number]): string {
  if (t.isIdentifier(param)) return `${param.name}: ${identifierTypeCode(param)}`;
  if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
    return `...${param.argument.name}: ${identifierTypeCode(param.argument)}`;
  }
  if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
    return `${param.left.name}?: ${identifierTypeCode(param.left)}`;
  }
  return `${printNodeCode(param)}: unknown`;
}

function identifierTypeCode(node: t.Identifier): string {
  const annotation = node.typeAnnotation;
  return annotation && t.isTSTypeAnnotation(annotation) ? printNodeCode(annotation.typeAnnotation) : "unknown";
}

function objectPropertyKeyName(node: t.ObjectProperty): string | null {
  return typeMemberKeyName(node.key);
}

function typeMemberKeyName(node: t.Expression | t.PrivateName | t.Identifier | t.StringLiteral | t.NumericLiteral): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return String(node.value);
  return null;
}

function collectDeclarationBindings(bindings: Map<string, FileBinding>, statement: t.Statement, declaration: t.Statement | t.Declaration, exported: boolean): void {
  if (t.isFunctionDeclaration(declaration) && declaration.id) {
    bindings.set(declaration.id.name, { name: declaration.id.name, kind: "function", node: statement, declaration, exported });
  } else if (t.isClassDeclaration(declaration) && declaration.id) {
    bindings.set(declaration.id.name, { name: declaration.id.name, kind: "class", node: statement, declaration, exported });
  } else if (t.isTSTypeAliasDeclaration(declaration)) {
    bindings.set(declaration.id.name, { name: declaration.id.name, kind: "type", node: statement, declaration, exported });
  } else if (t.isTSInterfaceDeclaration(declaration)) {
    bindings.set(declaration.id.name, { name: declaration.id.name, kind: "interface", node: statement, declaration, exported });
  } else if (t.isVariableDeclaration(declaration)) {
    for (const item of declaration.declarations) {
      for (const name of bindingNames(item.id)) bindings.set(name, { name, kind: declaration.kind, node: statement, declaration, exported });
    }
  }
}

function bindingNames(pattern: t.LVal | t.VoidPattern): string[] {
  if (t.isVoidPattern(pattern)) return [];
  if (t.isIdentifier(pattern)) return [pattern.name];
  if (t.isObjectPattern(pattern)) return pattern.properties.flatMap((prop) => {
    if (t.isObjectProperty(prop)) return bindingNames(prop.value as t.LVal);
    if (t.isRestElement(prop)) return bindingNames(prop.argument as t.LVal);
    return [];
  });
  if (t.isArrayPattern(pattern)) return pattern.elements.flatMap((item) => item ? bindingNames(item as t.LVal) : []);
  if (t.isAssignmentPattern(pattern)) return bindingNames(pattern.left);
  if (t.isRestElement(pattern)) return bindingNames(pattern.argument as t.LVal);
  return [];
}

function parseHelperOverrides(items: string[]): Map<string, HelperAction | "move" | "share" | "as-prop"> {
  const overrides = new Map<string, HelperAction | "move" | "share" | "as-prop">();
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq <= 0) fail("INVALID_EXTRACT", `Invalid --helper override: ${item}`);
    const name = item.slice(0, eq).trim();
    const raw = item.slice(eq + 1).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) fail("INVALID_EXTRACT", `Invalid helper name: ${name}`);
    if (!["move", "share", "leave", "as-prop"].includes(raw)) {
      fail("INVALID_EXTRACT", `Invalid helper action for ${name}: ${raw}`);
    }
    overrides.set(name, raw === "leave" ? "passed-as-prop" : raw as "move" | "share" | "as-prop");
  }
  return overrides;
}

function planHelper(input: {
  source: string;
  ast: t.File;
  binding: FileBinding;
  fromFile: string;
  toFile: string;
  extractionRanges: SourceRange[];
  policy: HelperPolicy;
  override?: HelperAction | "move" | "share" | "as-prop";
}): HelperPlan {
  const remaining = countIdentifierReferencesOutsideRanges(input.source, input.ast, input.binding.name, input.extractionRanges);
  const helperClass: HelperResult["class"] = remaining === 0 ? "shell-only" : "shared";
  const action = resolveHelperAction(input.binding.name, helperClass, input.policy, input.override);
  const baseResult = {
    name: input.binding.name,
    kind: input.binding.kind,
    class: helperClass,
    action,
    source_refs_remaining: remaining,
  };

  if (action === "moved") {
    return {
      result: baseResult,
      binding: input.binding,
      sourcePatch: buildRemoveStatementPatch(input.source, input.binding.node),
      movedSource: readNodeSource(input.source, input.binding.node),
    };
  }

  if (action === "shared-via-import") {
    const importFrom = relativeImportPath(input.toFile, input.fromFile);
    return {
      result: { ...baseResult, import_added_to_new_file: { from: importFrom, named: [input.binding.name] } },
      binding: input.binding,
      sourcePrefixPatch: input.binding.exported ? undefined : buildExportPrefixPatch(input.source, input.binding.node),
      importForNewFile: { from: importFrom, named: [input.binding.name] },
    };
  }

  return {
    result: { ...baseResult, action: "passed-as-prop" },
    binding: input.binding,
    prop: { name: input.binding.name, ...(inferFileBindingPropType(input.binding) ?? { type: "unknown" }), source: "helper-prop" },
  };
}

function inferFileBindingPropType(binding: FileBinding): InferredPropType | null {
  if (t.isFunctionDeclaration(binding.declaration)) return inferFunctionLikeType(binding.declaration);
  if (t.isVariableDeclaration(binding.declaration)) {
    const declaration = binding.declaration.declarations.find((item) => bindingNames(item.id).includes(binding.name));
    return declaration ? inferVariableDeclaratorType(declaration) : null;
  }
  return null;
}

function failOnSharedHelperCycles(helperPlans: HelperPlan[]): void {
  const cyclePlans = helperPlans.filter((plan) => plan.result.action === "shared-via-import");
  if (cyclePlans.length === 0) return;

  const helpers = cyclePlans.map((plan) => ({
    name: plan.result.name,
    class: plan.result.class,
    sourceRefsRemaining: plan.result.source_refs_remaining,
  }));
  const names = helpers.map((helper) => helper.name).join(", ");
  fail(
    "SHARED_HELPER_CYCLE",
    `Extract would create module cycles for ${helpers.length} helper(s): ${names}.`,
    {
      helpers,
      workarounds: [
        "--helpers as-prop",
        "pass individual --helper name=as-prop / name=leave",
        "move shared helpers to a separate shared module first",
      ],
    },
  );
}

function expandMovedHelperClosure(input: {
  source: string;
  ast: t.File;
  fileBindings: Map<string, FileBinding>;
  importBindings: Map<string, ImportedBinding>;
  usedImports: ImportedBinding[];
  helperPlans: HelperPlan[];
  helperPlanByName: Map<string, HelperPlan>;
  extractionRanges: SourceRange[];
  fromFile: string;
  toFile: string;
  policy: HelperPolicy;
  overrides: Map<string, HelperAction | "move" | "share" | "as-prop">;
  slotPropNames: Set<string>;
}): void {
  const processedMovedHelpers = new Set<string>();

  for (let index = 0; index < input.helperPlans.length; index++) {
    const plan = input.helperPlans[index];
    if (plan.result.action !== "moved" || !plan.binding || !plan.movedSource) continue;
    if (processedMovedHelpers.has(plan.result.name)) continue;
    processedMovedHelpers.add(plan.result.name);

    const references = collectExternalReferencesFromSource(plan.movedSource);
    for (const name of references) {
      if (name === plan.result.name || input.slotPropNames.has(name) || GLOBAL_IDENTIFIERS.has(name)) continue;

      const imported = input.importBindings.get(name);
      if (imported) {
        input.usedImports.push(imported);
        continue;
      }

      const binding = input.fileBindings.get(name);
      if (!binding || input.helperPlanByName.has(name)) continue;

      const dependencyPlan = planHelper({
        source: input.source,
        ast: input.ast,
        binding,
        fromFile: input.fromFile,
        toFile: input.toFile,
        extractionRanges: input.extractionRanges,
        policy: input.policy,
        override: input.overrides.get(name),
      });
      input.helperPlans.push(dependencyPlan);
      input.helperPlanByName.set(name, dependencyPlan);
      if (dependencyPlan.binding && dependencyPlan.result.action === "moved") {
        input.extractionRanges.push(nodeRange(input.source, dependencyPlan.binding.node));
      }
    }
  }
}

function collectExternalReferencesFromSource(source: string): string[] {
  const ast = recast.parse(source, { parser: babelTsParser }) as unknown as t.File;
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  traverseAst(ast, {
    JSXElement(path) {
      const name = jsxNameBase(path.node.openingElement.name);
      if (name && /^[A-Z]/.test(name)) add(name);
    },
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const name = path.node.name;
      if (path.scope.hasBinding(name)) return;
      add(name);
    },
    TSTypeReference(path) {
      const typeName = path.node.typeName;
      if (t.isIdentifier(typeName) && !path.scope.hasBinding(typeName.name)) add(typeName.name);
    },
  });

  return names;
}

function resolveHelperAction(
  name: string,
  helperClass: HelperResult["class"],
  policy: HelperPolicy,
  override?: HelperAction | "move" | "share" | "as-prop",
): HelperAction {
  const requested = override ?? policy;
  if (requested === "move") {
    if (helperClass === "shared") {
      fail("SHARED_HELPER_MOVE_REFUSED", `Helper "${name}" is still referenced in the source file; refusing to move it.`);
    }
    return "moved";
  }
  if (requested === "share") return "shared-via-import";
  if (requested === "as-prop") return "passed-as-prop";
  if (requested === "passed-as-prop") return "passed-as-prop";
  if (requested === "moved") return "moved";
  if (requested === "shared-via-import") return "shared-via-import";
  return helperClass === "shell-only" ? "moved" : "shared-via-import";
}

function countIdentifierReferencesOutsideRanges(source: string, ast: t.File, name: string, ranges: SourceRange[]): number {
  let count = 0;
  traverseAst(ast, {
    Identifier(path) {
      if (path.node.name !== name || !path.isReferencedIdentifier()) return;
      if (isNodeInsideAnyRange(source, path.node, ranges)) return;
      count++;
    },
    JSXElement(path) {
      const tag = jsxNameBase(path.node.openingElement.name);
      if (tag !== name) return;
      if (isNodeInsideAnyRange(source, path.node.openingElement.name, ranges)) return;
      count++;
    },
  });
  return count;
}

function isNodeInsideAnyRange(source: string, node: t.Node, ranges: SourceRange[]): boolean {
  const nodeSource = nodeSourceRange(source, node);
  if (!nodeSource) return false;
  return ranges.some((range) => nodeSource.start >= range.start && nodeSource.end <= range.end);
}

function nodeRange(source: string, node: t.Node): SourceRange {
  const range = nodeSourceRange(source, node);
  if (!range) {
    fail("UNSUPPORTED_EXTRACT", "Node is missing source positions.");
  }
  return range;
}

function readNodeSource(source: string, node: t.Node): string {
  const range = nodeRange(source, node);
  return source.slice(range.start, range.end);
}

function buildRemoveStatementPatch(source: string, node: t.Node): SourcePatch {
  const range = nodeRange(source, node);
  const span = getStatementRemovalSpan(source, range.start, range.end);
  return { start: span.start, end: span.end, text: "" };
}

function buildExportPrefixPatch(source: string, node: t.Node): SourcePatch {
  const range = nodeRange(source, node);
  return { start: range.start, end: range.start, text: "export " };
}

function planUnusedImportRemoval(
  source: string,
  ast: t.File,
  imports: ImportedBinding[],
  extractionRanges: SourceRange[],
): { patches: SourcePatch[]; removed: ImportedBinding[] } {
  const removable = imports.filter((item) => countIdentifierReferencesOutsideRanges(source, ast, item.local, extractionRanges) === 0);
  if (removable.length === 0) return { patches: [], removed: [] };

  const byDeclaration = new Map<t.ImportDeclaration, ImportedBinding[]>();
  for (const item of removable) {
    const group = byDeclaration.get(item.declaration) ?? [];
    group.push(item);
    byDeclaration.set(item.declaration, group);
  }

  const patches: SourcePatch[] = [];
  for (const [declaration, group] of byDeclaration) {
    const specifiers = new Set(group.map((item) => item.specifier));
    if (specifiers.size === declaration.specifiers.length) {
      patches.push(buildRemoveStatementPatch(source, declaration));
      continue;
    }
    for (const specifier of group.map((item) => item.specifier)) {
      patches.push(buildRemoveImportSpecifierPatch(source, declaration, specifier));
    }
  }

  return { patches, removed: removable };
}

function buildRemoveImportSpecifierPatch(
  source: string,
  declaration: t.ImportDeclaration,
  specifier: t.ImportDeclaration["specifiers"][number],
): SourcePatch {
  const index = declaration.specifiers.indexOf(specifier);
  const specRange = nodeSourceRange(source, specifier);
  if (index < 0 || !specRange) {
    fail("UNSUPPORTED_EXTRACT", "Import specifier is missing source positions.");
  }

  const previous = declaration.specifiers[index - 1];
  const next = declaration.specifiers[index + 1];
  let start = specRange.start;
  let end = specRange.end;

  const previousRange = previous ? nodeSourceRange(source, previous) : null;
  const nextRange = next ? nodeSourceRange(source, next) : null;
  if (previousRange) {
    start = previousRange.end;
  } else if (nextRange) {
    end = nextRange.start;
  }

  return { start, end, text: "" };
}

function dedupeImports(imports: ImportedBinding[]): ImportedBinding[] {
  const seen = new Set<string>();
  return imports.filter((item) => {
    const key = `${item.source}:${item.kind}:${item.imported ?? ""}:${item.local}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeImports(imports: ImportedBinding[]): ExtractResult["imports"]["transferred"] {
  const bySource = new Map<string, { from: string; named: string[]; default?: string; namespace?: string }>();
  for (const item of imports) {
    const group = bySource.get(item.source) ?? { from: item.source, named: [] };
    if (item.kind === "named") {
      group.named.push(item.imported === item.local || !item.imported ? item.local : `${item.imported} as ${item.local}`);
    } else if (item.kind === "default") {
      group.default = item.local;
    } else {
      group.namespace = item.local;
    }
    bySource.set(item.source, group);
  }
  return [...bySource.values()].map((item) => ({
    from: item.from,
    ...(item.named.length > 0 ? { named: item.named } : {}),
    ...(item.default ? { default: item.default } : {}),
    ...(item.namespace ? { namespace: item.namespace } : {}),
  }));
}

function planPropTypeImports(input: {
  source: string;
  props: ExtractPropResult[];
  importBindings: Map<string, ImportedBinding>;
  fileBindings: Map<string, FileBinding>;
  fromFile: string;
  toFile: string;
}): { imports: ImportSpec[]; sourcePatches: SourcePatch[] } {
  const imports: ImportSpec[] = [];
  const sourcePatches: SourcePatch[] = [];
  const seen = new Set<string>();

  for (const prop of input.props) {
    for (const name of collectTypeReferenceNames(prop.type)) {
      if (GLOBAL_IDENTIFIERS.has(name) || seen.has(name)) continue;
      seen.add(name);

      const imported = input.importBindings.get(name);
      if (imported) {
        imports.push(importedBindingToTypeImport(imported, input.fromFile, input.toFile));
        continue;
      }

      const binding = input.fileBindings.get(name);
      if (!binding || (binding.kind !== "type" && binding.kind !== "interface" && binding.kind !== "class")) continue;
      imports.push({ from: relativeImportPath(input.toFile, input.fromFile), named: [name], type: true });
      if (!binding.exported) sourcePatches.push(buildExportPrefixPatch(input.source, binding.node));
    }
  }

  return { imports, sourcePatches };
}

function importedBindingToTypeImport(binding: ImportedBinding, fromFile: string, toFile: string): ImportSpec {
  const source = rebaseImportSourceForExtract(fromFile, toFile, binding.source);
  if (binding.kind === "default") return { from: source, default: binding.local, type: true };
  if (binding.kind === "namespace") return { from: source, namespace: binding.local, type: true };
  return {
    from: source,
    named: [binding.imported === binding.local || !binding.imported ? binding.local : `${binding.imported} as ${binding.local}`],
    type: true,
  };
}

function rebaseImportSourceForExtract(fromFile: string, toFile: string, source: string): string {
  return source.startsWith(".") ? relativeImportPath(toFile, resolve(dirname(fromFile), source)) : source;
}

function collectTypeReferenceNames(typeCode: string): string[] {
  const ast = recast.parse(`type __T = ${typeCode};`, { parser: babelTsParser }) as unknown as t.File;
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  traverseAst(ast, {
    TSTypeReference(path) {
      const name = typeReferenceBaseName(path.node.typeName);
      if (name) add(name);
    },
  });

  return names;
}

function typeReferenceBaseName(name: t.TSTypeReference["typeName"]): string | null {
  if (t.isIdentifier(name)) return name.name;
  return typeReferenceBaseName(name.left);
}

function buildExtractedSource(input: {
  name: string;
  exportKind: "named" | "default";
  shellNode: ContainerNode;
  props: ExtractPropResult[];
  imports: ImportSpec[];
  movedHelpers: string[];
  needsReactNode: boolean;
}): string {
  const imports = input.imports.map(formatImport).filter(Boolean);
  if (input.needsReactNode) imports.push('import type { ReactNode } from "react";');

  const propTypeName = `${input.name}Props`;
  const typeBlock = input.props.length > 0
    ? `type ${propTypeName} = {\n${input.props.map(formatPropTypeLine).join("\n")}\n};\n\n`
    : "";
  const params = input.props.length > 0
    ? `{ ${input.props.map((prop) => prop.name).join(", ")} }: ${propTypeName}`
    : "";
  const exportPrefix = input.exportKind === "default" ? "export default" : "export";
  const jsx = indentBlock(stripRedundantJsxParens(printNodeCode(input.shellNode)), 4);
  const importBlock = imports.length > 0 ? `${imports.join("\n")}\n\n` : "";
  const helperBlock = input.movedHelpers.length > 0 ? `${input.movedHelpers.join("\n\n")}\n\n` : "";

  return `${importBlock}${helperBlock}${typeBlock}${exportPrefix} function ${input.name}(${params}) {\n  return (\n${jsx}\n  );\n}\n`;
}

function formatPropTypeLine(prop: ExtractPropResult): string {
  const todo = prop.type === "unknown" ? " // TODO(tedit): infer type" : "";
  return `  ${prop.name}${prop.optional ? "?" : ""}: ${prop.type};${todo}`;
}

function buildCallSite(name: string, freeProps: ExtractPropResult[], slots: SlotPlan[]): string {
  const attrs = freeProps.map((prop) => `${prop.name}={${prop.name}}`);
  const namedSlots = slots.filter((slot) => slot.prop !== "children");
  for (const slot of namedSlots) attrs.push(`${slot.prop}={<>${trimBlankLines(slot.content)}</>}`);

  const attrText = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  const children = slots.find((slot) => slot.prop === "children");
  if (!children) return `<${name}${attrText} />`;
  return `<${name}${attrText}>${children.content}</${name}>`;
}

function buildSourceComponentImport(fromFile: string, toFile: string, name: string, exportKind: "named" | "default"): {
  from: string;
  named?: string[];
  default?: string;
} {
  const importPath = relativeImportPath(fromFile, toFile);
  return exportKind === "default"
    ? { from: importPath, default: name }
    : { from: importPath, named: [name] };
}

function buildAddImportPatch(source: string, ast: t.File, spec: { from: string; named?: string[]; default?: string }): SourcePatch {
  const existing = ast.program.body.find((statement): statement is t.ImportDeclaration => {
    return t.isImportDeclaration(statement) && statement.source.value === spec.from;
  });

  if (existing) {
    const names = spec.named ?? [];
    if (names.length > 0) {
      const named = existing.specifiers.filter((item): item is t.ImportSpecifier => t.isImportSpecifier(item));
      const existingNames = new Set(named.map((item) => item.local.name));
      const missing = names.filter((name) => !existingNames.has(name));
      if (missing.length === 0) return { start: 0, end: 0, text: "" };
      const lastNamed = named.at(-1);
      const lastNamedRange = lastNamed ? nodeSourceRange(source, lastNamed) : null;
      if (lastNamedRange) return { start: lastNamedRange.end, end: lastNamedRange.end, text: `, ${missing.join(", ")}` };
      const defaultSpecifier = existing.specifiers.find((item): item is t.ImportDefaultSpecifier => t.isImportDefaultSpecifier(item));
      const defaultRange = defaultSpecifier ? nodeSourceRange(source, defaultSpecifier) : null;
      if (defaultRange) {
        return { start: defaultRange.end, end: defaultRange.end, text: `, { ${missing.join(", ")} }` };
      }
    }
    if (spec.default && !existing.specifiers.some((item) => t.isImportDefaultSpecifier(item))) {
      const first = existing.specifiers[0];
      const start = first ? nodeSourceRange(source, first)?.start : nodeSourceRange(source, existing.source)?.start;
      if (typeof start === "number") return { start, end: start, text: `${spec.default}, ` };
    }
    fail("UNSUPPORTED_EXTRACT", `Cannot add component import to existing import ${spec.from}.`);
  }

  const imports = ast.program.body.filter((statement): statement is t.ImportDeclaration => t.isImportDeclaration(statement));
  const last = imports.at(-1);
  const insertionPoint = last ? nodeSourceRange(source, last)?.end ?? 0 : 0;
  const prefix = insertionPoint === 0 ? "" : "\n";
  return {
    start: insertionPoint,
    end: insertionPoint,
    text: `${prefix}${formatImport(spec)}${insertionPoint === 0 ? "\n" : ""}`,
  };
}

function formatImport(spec: ImportSpec): string {
  const clauses: string[] = [];
  if (spec.default) clauses.push(spec.default);
  if (spec.namespace) clauses.push(`* as ${spec.namespace}`);
  if (spec.named && spec.named.length > 0) clauses.push(`{ ${spec.named.join(", ")} }`);
  if (clauses.length === 0) return "";
  return `import ${spec.type ? "type " : ""}${clauses.join(", ")} from ${JSON.stringify(spec.from)};`;
}

function relativeImportPath(fromFile: string, toFile: string): string {
  let value = relative(dirname(fromFile), toFile).replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function sourceForRange(source: string, node: t.Node): string | null {
  const range = nodeSourceRange(source, node);
  return range ? source.slice(range.start, range.end) : null;
}

function nodeSourceRange(source: string, node: t.Node): SourceRange | null {
  if (node.loc) {
    const starts = lineStartOffsets(source);
    return {
      start: (starts[node.loc.start.line - 1] ?? 0) + node.loc.start.column,
      end: (starts[node.loc.end.line - 1] ?? 0) + node.loc.end.column,
    };
  }
  if (typeof node.start !== "number" || typeof node.end !== "number") return null;
  return { start: node.start, end: node.end };
}

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function applySourcePatches(source: string, patches: SourcePatch[]): string {
  const ordered = patches
    .filter((patch) => patch.start !== patch.end || patch.text !== "")
    .sort((a, b) => b.start - a.start);
  let output = source;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const patch of ordered) {
    if (patch.end > previousStart) fail("OVERLAPPING_PATCHES", "Internal extract patches overlap.");
    output = `${output.slice(0, patch.start)}${patch.text}${output.slice(patch.end)}`;
    previousStart = patch.start;
  }
  return output;
}

function getStatementRemovalSpan(source: string, start: number, end: number): { start: number; end: number } {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEndRaw = source.indexOf("\n", end);
  const lineEnd = lineEndRaw < 0 ? source.length : lineEndRaw + 1;
  if (
    source.slice(lineStart, start).trim() === "" &&
    source.slice(end, lineEndRaw < 0 ? lineEnd : lineEndRaw).trim() === ""
  ) {
    return { start: lineStart, end: lineEnd };
  }
  return { start, end };
}

function extractProps(attrs: Array<t.JSXAttribute | t.JSXSpreadAttribute>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (t.isJSXSpreadAttribute(attr)) {
      props[`...${printNodeCode(attr.argument)}`] = { type: "spread", code: printNodeCode(attr.argument) };
      continue;
    }
    const name = jsxNameToString(attr.name);
    if (attr.value === null) props[name] = true;
    else if (t.isStringLiteral(attr.value)) props[name] = attr.value.value;
    else if (t.isJSXExpressionContainer(attr.value)) props[name] = { type: "expr", code: printNodeCode(attr.value.expression) };
    else props[name] = { type: "unknown" };
  }
  return props;
}

function jsxNameToString(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`;
  return `${jsxNameToString(name.object)}.${jsxNameToString(name.property)}`;
}

function jsxNameBase(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string | null {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) return jsxNameBase(name.object);
  return null;
}

function importedNameToString(name: t.ImportSpecifier["imported"]): string {
  return t.isIdentifier(name) ? name.name : name.value;
}

function isWhitespaceText(node: t.JSXElement["children"][number]): boolean {
  return t.isJSXText(node) && node.value.trim() === "";
}

function isIndexableNode(node: unknown): node is IndexedNode {
  return !!node && typeof node === "object" && (
    t.isJSXElement(node as t.Node) ||
    t.isJSXFragment(node as t.Node) ||
    t.isJSXExpressionContainer(node as t.Node)
  );
}

function printNodeCode(node: t.Node): string {
  return recast.print(node).code;
}

function indentBlock(input: string, spaces: number): string {
  const indent = " ".repeat(spaces);
  return input.split("\n").map((line) => `${indent}${line}`).join("\n");
}

function trimBlankLines(input: string): string {
  return input.replace(/^\s*\n/, "").replace(/\n\s*$/, "");
}

function stripRedundantJsxParens(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return input;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner.startsWith("<")) return input;
  const leading = input.match(/^\s*/)?.[0] ?? "";
  const trailing = input.match(/\s*$/)?.[0] ?? "";
  return `${leading}${inner}${trailing}`;
}

function findTopLevelEquals(input: string): number {
  let quote: string | null = null;
  let bracketDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote && input[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "=" && bracketDepth === 0 && parenDepth === 0 && braceDepth === 0) return index;
  }

  return -1;
}
