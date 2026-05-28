import { readFileSync, writeFileSync } from "node:fs";
import { parseExpression } from "@babel/parser";
import traverseModule, { type NodePath, type TraverseOptions } from "@babel/traverse";
import * as t from "@babel/types";
import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import { BaseTreeDocument } from "../../core/base-tree-document.js";
import type { CommentPosition, ImportEditSpec, StructuredDocument, TextMatchSpec, TextValueSpec, TreeNodeInfo, TreeNodeSpec, ValueSpec } from "../../core/document.js";
import { fail } from "../../errors.js";

const traverseAst = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (
  parent: t.Node,
  opts: TraverseOptions,
) => void;

export type PropSpec = ValueSpec;
export type ElementSpec = TreeNodeSpec;
export type NodeInfo = TreeNodeInfo;

type IndexedNode = t.JSXElement | t.JSXFragment | t.JSXExpressionContainer;
type ContainerNode = t.JSXElement | t.JSXFragment;
type IndexedPath = NodePath<IndexedNode>;
type ContainerPath = NodePath<ContainerNode>;
type SourcePatch = {
  start: number;
  end: number;
  text: string;
};
type SourceRange = {
  start: number;
  end: number;
};

export class JsxDocument extends BaseTreeDocument<IndexedPath> implements StructuredDocument {
  private ast: t.File;
  private patches: SourcePatch[] = [];
  private canUseSourcePatches = true;

  constructor(filePath: string, source: string) {
    super("jsx", filePath, source);
    this.ast = recast.parse(source, { parser: babelTsParser }) as unknown as t.File;
    this.reindex();
  }

  append(target: string, spec: ElementSpec): NodeInfo {
    const path = this.resolveContainerPath(target);
    const child = buildChild(spec);
    const childId = isIndexableNode(child) ? this.getNodeId(child) : undefined;

    this.addInsertChildPatch(path, child, "append");
    path.node.children.push(child);
    if (t.isJSXElement(path.node) && path.node.openingElement.selfClosing) {
      path.node.openingElement.selfClosing = false;
      path.node.closingElement = t.jsxClosingElement(cloneJsxName(path.node.openingElement.name));
    }

    this.reindex();
    return childId ? this.resolveInfo(childId) : this.resolveInfo(target);
  }

  prepend(target: string, spec: ElementSpec): NodeInfo {
    const path = this.resolveContainerPath(target);
    const child = buildChild(spec);
    const childId = isIndexableNode(child) ? this.getNodeId(child) : undefined;

    this.addInsertChildPatch(path, child, "prepend");
    path.node.children.unshift(child);
    if (t.isJSXElement(path.node) && path.node.openingElement.selfClosing) {
      path.node.openingElement.selfClosing = false;
      path.node.closingElement = t.jsxClosingElement(cloneJsxName(path.node.openingElement.name));
    }

    this.reindex();
    return childId ? this.resolveInfo(childId) : this.resolveInfo(target);
  }

  wrap(target: string, wrapperSpec: ElementSpec): NodeInfo {
    const path = this.resolvePath(target);
    if (!wrapperSpec.tag && !wrapperSpec.name) fail("INVALID_ELEMENT", "wrap requires an element spec with a tag or name.");

    const targetNode = path.node;
    const wrapper = buildElementNode({ ...wrapperSpec, children: [] });
    const wrapperId = this.getNodeId(wrapper);
    wrapper.openingElement.selfClosing = false;
    wrapper.closingElement = t.jsxClosingElement(cloneJsxName(wrapper.openingElement.name));

    this.addWrapPatches(targetNode, wrapper);

    wrapper.children.push(targetNode);
    path.replaceWith(wrapper);
    this.reindex();
    return this.resolveInfo(wrapperId);
  }

  unwrap(target: string): NodeInfo | null {
    const path = this.resolveContainerPath(target);
    const children = path.node.children.length > 0 ? path.node.children : [];

    this.addUnwrapPatch(path.node);
    path.replaceWithMultiple(children);
    this.reindex();
    return null;
  }

  rename(target: string, name: string): NodeInfo {
    const path = this.resolveElementPath(target);
    const nextName = buildJsxName(name);
    this.addNamePatch(path.node.openingElement.name, name);
    if (path.node.closingElement) {
      this.addNamePatch(path.node.closingElement.name, name);
    }
    path.node.openingElement.name = nextName;
    if (path.node.closingElement) {
      path.node.closingElement.name = cloneJsxName(nextName);
    }
    this.reindex();
    return this.resolveInfo(target);
  }

  remove(target: string): void {
    const path = this.resolvePath(target);
    this.addRemoveNodePatch(path.node);
    path.remove();
    this.reindex();
  }

  setProp(target: string, name: string, value: PropSpec): NodeInfo {
    return this.setAttribute(target, name, value);
  }

  setAttribute(target: string, name: string, value: PropSpec): NodeInfo {
    const path = this.resolveElementPath(target);
    const attr = buildAttribute(name, value);
    this.addSetAttributePatch(path.node.openingElement, name, attr);

    if (t.isJSXSpreadAttribute(attr)) {
      path.node.openingElement.attributes.push(attr);
    } else {
      const attrs = path.node.openingElement.attributes;
      const index = attrs.findIndex((candidate) => t.isJSXAttribute(candidate) && jsxNameToString(candidate.name) === name);
      if (index >= 0) attrs[index] = attr;
      else attrs.push(attr);
    }
    this.reindex();
    return this.resolveInfo(target);
  }

  removeProp(target: string, name: string): NodeInfo {
    return this.removeAttribute(target, name);
  }

  removeAttribute(target: string, name: string): NodeInfo {
    const path = this.resolveElementPath(target);
    this.addRemoveAttributePatch(path.node.openingElement, name);

    path.node.openingElement.attributes = path.node.openingElement.attributes.filter((attr) => {
      return !(t.isJSXAttribute(attr) && jsxNameToString(attr.name) === name);
    });
    this.reindex();
    return this.resolveInfo(target);
  }

  addClass(target: string, classNames: string | string[]): NodeInfo {
    return this.updateClassList(target, (classes) => uniqueClassNames([...classes, ...normalizeClassNames(classNames)]));
  }

  removeClass(target: string, classNames: string | string[]): NodeInfo {
    const remove = new Set(normalizeClassNames(classNames));
    return this.updateClassList(target, (classes) => classes.filter((name) => !remove.has(name)));
  }

  replaceClass(target: string, from: string, to: string): NodeInfo {
    const fromNames = normalizeClassNames(from);
    const toNames = normalizeClassNames(to);
    if (fromNames.length !== 1) fail("INVALID_CLASS", "class.replace requires exactly one source class.");
    if (toNames.length === 0) fail("INVALID_CLASS", "class.replace requires at least one replacement class.");
    let replaced = false;
    const next = this.updateClassList(target, (classes) => {
      const result: string[] = [];
      for (const name of classes) {
        if (name === fromNames[0]) {
          result.push(...toNames);
          replaced = true;
        } else {
          result.push(name);
        }
      }
      return uniqueClassNames(result);
    });
    if (!replaced) fail("CLASS_NOT_FOUND", `Class "${fromNames[0]}" was not found on target.`);
    return next;
  }

  private updateClassList(target: string, update: (classes: string[]) => string[]): NodeInfo {
    const path = this.resolveElementPath(target);
    const existing = findClassAttribute(path.node.openingElement);
    const current = existing ? readStringAttributeValue(existing) : "";
    if (current === null) {
      fail("UNSUPPORTED_CLASS_VALUE", "class.* actions only support static string className/class attributes. Use prop.set for expression values.", {
        prop: existing ? jsxNameToString(existing.name) : "className",
      });
    }

    const next = update(splitClassNames(current)).join(" ");
    if (!existing && next.length === 0) return this.resolveInfo(this.getNodeId(path.node));
    const propName = existing ? jsxNameToString(existing.name) : "className";
    return this.setAttribute(this.getNodeId(path.node), propName, { type: "string", value: next });
  }

  insertComment(target: string, text: string, position: CommentPosition = "inside-end"): NodeInfo {
    const path = this.resolvePath(target);
    const comment = buildComment(text);
    this.addInsertCommentPatch(path, text, position);

    if (position === "before") {
      path.insertBefore(comment);
    } else if (position === "after") {
      path.insertAfter(comment);
    } else if (position === "inside-start") {
      const container = this.resolveContainerPath(target);
      container.node.children.unshift(comment);
    } else {
      const container = this.resolveContainerPath(target);
      container.node.children.push(comment);
    }

    this.reindex();
    return this.resolveInfo(target);
  }

  setText(target: string, value: TextValueSpec): NodeInfo {
    const path = this.resolveContainerPath(target);
    const child = buildTextValueChild(value);
    this.addSetTextPatch(path, printNodeCode(child));

    path.node.children = [child];
    if (path.isJSXElement() && path.node.openingElement.selfClosing) {
      path.node.openingElement.selfClosing = false;
      path.node.closingElement = t.jsxClosingElement(cloneJsxName(path.node.openingElement.name));
    }

    this.reindex();
    return this.resolveInfo(target);
  }

  replaceText(target: string, match: TextMatchSpec, value: TextValueSpec): NodeInfo {
    const path = this.resolveContainerPath(target);
    const replacement = buildTextValueChild(value);
    let replaced = 0;

    path.node.children = path.node.children.map((child) => {
      if (!matchesTextChild(child, match, this.source)) return child;
      this.addReplaceTextChildPatch(child, replacement, value);
      replaced++;
      return t.cloneNode(replacement, true);
    });

    if (replaced === 0) {
      fail("TEXT_MATCH_NONE", `No JSX text child matched ${describeTextMatch(match)}.`, textMatchNoneDetails(path.node.children, match, this.source));
    }

    this.reindex();
    return this.resolveInfo(target);
  }

  addImport(spec: ImportEditSpec): unknown {
    const normalized = normalizeImportSpec(spec);
    if (!normalized.defaultName && !normalized.namespace && normalized.named.length === 0) {
      fail("INVALID_IMPORT", "imports.add requires at least one of named, default, or namespace.");
    }

    const declaration = this.findImportDeclaration(normalized.from);
    if (declaration) {
      return this.addToExistingImport(declaration, normalized);
    }

    const insertionPoint = this.findImportInsertionPoint();
    const prefix = insertionPoint === 0 ? "" : "\n";
    this.patches.push({
      start: insertionPoint,
      end: insertionPoint,
      text: `${prefix}${buildImportDeclarationText(normalized)}${insertionPoint === 0 ? "\n" : ""}`,
    });
    return { changed: true, from: normalized.from, added: normalized.named };
  }

  removeImport(spec: ImportEditSpec): unknown {
    const normalized = normalizeImportSpec(spec);
    if (!normalized.defaultName && !normalized.namespace && normalized.named.length === 0) {
      fail("INVALID_IMPORT", "imports.remove requires named, default, namespace, or name.");
    }

    const declaration = this.findImportDeclaration(normalized.from);
    if (!declaration) return { changed: false, from: normalized.from };

    const nextSpecifiers = declaration.specifiers.filter((specifier) => !shouldRemoveImportSpecifier(specifier, normalized));
    const removedSpecifiers = declaration.specifiers.filter((specifier) => shouldRemoveImportSpecifier(specifier, normalized));
    if (nextSpecifiers.length === declaration.specifiers.length) return { changed: false, from: normalized.from };

    if (typeof declaration.start !== "number" || typeof declaration.end !== "number") {
      this.disableSourcePatches();
      return { changed: true, from: normalized.from };
    }

    if (nextSpecifiers.length > 0 && removedSpecifiers.length === 1) {
      addRemoveImportSpecifierPatch(this.patches, declaration, removedSpecifiers[0]);
      return { changed: true, from: normalized.from, removed: normalized.named };
    }

    const text = nextSpecifiers.length === 0 ? "" : buildImportDeclarationFromSpecifiers(normalized.from, nextSpecifiers);
    this.patches.push({ start: declaration.start, end: declaration.end, text });
    return { changed: true, from: normalized.from, removed: normalized.named };
  }

  renameImport(spec: ImportEditSpec): unknown {
    const normalized = normalizeImportSpec(spec);
    const fromName = normalized.name ?? normalized.named[0];
    const toName = normalized.toName;
    if (!fromName || !toName) fail("INVALID_IMPORT", "imports.rename requires name and to.");

    const declaration = this.findImportDeclaration(normalized.from);
    if (!declaration) return { changed: false, from: normalized.from };

    for (const specifier of declaration.specifiers) {
      if (addRenameImportPatch(this.patches, specifier, fromName, toName)) {
        return { changed: true, from: normalized.from, name: fromName, to: toName };
      }
    }

    return { changed: false, from: normalized.from, name: fromName };
  }

  moveImport(spec: ImportEditSpec): unknown {
    const normalized = normalizeImportSpec(spec);
    if (!normalized.to) fail("INVALID_IMPORT", "imports.move requires to.");
    if (normalized.named.length === 0 && !normalized.defaultName && !normalized.namespace) {
      fail("INVALID_IMPORT", "imports.move requires named, default, or namespace.");
    }

    const removed = this.removeImport(normalized);
    const added = this.addImport({
      from: normalized.to,
      named: normalized.named,
      ...(normalized.defaultName ? { default: normalized.defaultName } : {}),
      ...(normalized.namespace ? { namespace: normalized.namespace } : {}),
    });
    return { changed: true, removed, added };
  }

  replaceExpression(target: string, code: string): NodeInfo {
    const path = this.resolveExpressionPath(target);
    const expression = parseExpressionNode(code);
    this.addReplaceExpressionPatch(path.node, code);
    path.node.expression = expression;
    this.reindex();
    return this.resolveInfo(this.getNodeId(path.node));
  }

  wrapExpression(target: string, code: string): NodeInfo {
    const path = this.resolveExpressionPath(target);
    const current = this.getExpressionSource(path.node).trim();
    if (!code.includes("$expr")) fail("INVALID_EXPRESSION", "expr.wrap code must contain a $expr placeholder.");
    return this.replaceExpression(this.getNodeId(path.node), code.replace(/\$expr\b/g, current));
  }

  unwrapExpression(target: string): NodeInfo {
    return this.toShortCircuitExpression(target);
  }

  toTernaryExpression(target: string, alternate = "null"): NodeInfo {
    const path = this.resolveExpressionPath(target);
    const expression = path.node.expression;
    if (!t.isLogicalExpression(expression) || expression.operator !== "&&") {
      fail("UNSUPPORTED_EXPRESSION", "expr.toTernary requires a && expression.");
    }

    const test = this.getNodeSource(expression.left);
    const consequent = this.getNodeSource(expression.right);
    return this.replaceExpression(this.getNodeId(path.node), `${test} ? ${consequent} : ${alternate}`);
  }

  toShortCircuitExpression(target: string): NodeInfo {
    const path = this.resolveExpressionPath(target);
    const expression = path.node.expression;
    if (!t.isConditionalExpression(expression)) {
      fail("UNSUPPORTED_EXPRESSION", "expr.toShortCircuit requires a conditional expression.");
    }
    if (!isEmptyAlternate(expression.alternate)) {
      fail("UNSUPPORTED_EXPRESSION", "expr.toShortCircuit only supports null, false, or undefined alternates.");
    }

    const test = this.getNodeSource(expression.test);
    const consequent = this.getNodeSource(expression.consequent);
    return this.replaceExpression(this.getNodeId(path.node), `${test} && ${consequent}`);
  }

  print(): string {
    if (this.canUseSourcePatches && this.patches.length > 0) {
      return applySourcePatches(this.source, this.patches);
    }

    return recast.print(this.ast).code;
  }

  save(): void {
    writeFileSync(this.filePath, this.print());
  }

  private reindex(): void {
    const paths: IndexedPath[] = [];
    traverseAst(this.ast, {
      JSXElement: (path) => {
        paths.push(path);
      },
      JSXFragment: (path) => {
        paths.push(path);
      },
      JSXExpressionContainer: (path) => {
        paths.push(path);
      },
    });
    this.reindexPaths(paths);
  }

  protected override nodeForPath(path: IndexedPath): object {
    return path.node;
  }

  protected override buildInfo(id: string, path: IndexedPath): NodeInfo {
    const node = path.node;
    const kind = t.isJSXElement(node) ? "element" : t.isJSXFragment(node) ? "fragment" : "expression";
    const name = t.isJSXElement(node) ? jsxNameToString(node.openingElement.name) : t.isJSXFragment(node) ? "Fragment" : "Expression";
    const props = t.isJSXElement(node)
      ? extractProps(node.openingElement.attributes)
      : t.isJSXExpressionContainer(node)
        ? { expression: { type: "expr", code: printNodeCode(node.expression) } }
        : {};
    const childCount = t.isJSXElement(node) || t.isJSXFragment(node)
      ? node.children.filter((child) => !isWhitespaceText(child)).length
      : 0;

    return {
      id,
      kind,
      name,
      ...(node.loc ? {
        loc: {
          start: { line: node.loc.start.line, column: node.loc.start.column },
          end: { line: node.loc.end.line, column: node.loc.end.column },
        },
      } : {}),
      attributes: props,
      props,
      childCount,
      preview: compactPreview(this.source.slice(node.start ?? 0, node.end ?? 0)),
    };
  }

  protected override parentPath(path: IndexedPath): IndexedPath | null {
    return findNearestIndexedAncestor(path);
  }

  protected override siblingPaths(path: IndexedPath): IndexedPath[] {
    const siblings = findDirectJsxSiblings(path);
    if (!siblings) return [];
    return siblings
      .map((node) => this.pathForNode(node))
      .filter((sibling): sibling is IndexedPath => !!sibling);
  }

  protected override nodeNotFoundDetails(target: string): Record<string, unknown> {
    return {
      base_candidates: findBaseLiteralCandidates(this.source, target),
      next_step_hint: `If the intent was literal text editing, retry with: tedit edit ${this.filePath} --find ${JSON.stringify(selectorLiteralHint(target) ?? target)} --replace <text>`,
    };
  }

  private resolveElementPath(target: string): NodePath<t.JSXElement> {
    const path = this.resolvePath(target);
    if (!path.isJSXElement()) {
      fail("UNSUPPORTED_NODE", `Target "${target}" is not a JSX element.`);
    }
    return path;
  }

  private resolveContainerPath(target: string): ContainerPath {
    const path = this.resolvePath(target);
    if (!path.isJSXElement() && !path.isJSXFragment()) {
      fail("UNSUPPORTED_NODE", `Target "${target}" cannot contain JSX children.`);
    }
    return path as ContainerPath;
  }

  private resolveExpressionPath(target: string): NodePath<t.JSXExpressionContainer> {
    const path = this.resolvePath(target);
    if (path.isJSXExpressionContainer()) return path;

    const parent = findNearestExpressionContainer(path);
    if (parent) return parent;
    fail("UNSUPPORTED_NODE", `Target "${target}" is not inside a JSX expression container.`);
  }

  private findImportDeclaration(source: string): t.ImportDeclaration | undefined {
    return this.ast.program.body.find((statement): statement is t.ImportDeclaration => {
      return t.isImportDeclaration(statement) && statement.source.value === source;
    });
  }

  private findImportInsertionPoint(): number {
    const imports = this.ast.program.body.filter((statement): statement is t.ImportDeclaration => t.isImportDeclaration(statement));
    const last = imports.at(-1);
    if (!last || typeof last.end !== "number") return 0;
    return last.end;
  }

  private addToExistingImport(declaration: t.ImportDeclaration, spec: NormalizedImportSpec): unknown {
    const patchesBefore = this.patches.length;

    if (spec.defaultName && !declaration.specifiers.some((item) => t.isImportDefaultSpecifier(item))) {
      const firstSpecifier = declaration.specifiers[0];
      if (firstSpecifier && typeof firstSpecifier.start === "number") {
        this.patches.push({ start: firstSpecifier.start, end: firstSpecifier.start, text: `${spec.defaultName}, ` });
      }
    }

    if (spec.namespace && !declaration.specifiers.some((item) => t.isImportNamespaceSpecifier(item))) {
      if (declaration.specifiers.length > 0) {
        this.patches.push({
          start: declaration.specifiers[0].start ?? declaration.start ?? 0,
          end: declaration.specifiers[0].start ?? declaration.start ?? 0,
          text: `* as ${spec.namespace}, `,
        });
      }
    }

    const existingNamed = new Set(declaration.specifiers.flatMap((item) => {
      if (!t.isImportSpecifier(item)) return [];
      return [importedNameToString(item.imported), item.local.name];
    }));
    const missingNamed = spec.named.filter((name) => !existingNamed.has(name));
    if (missingNamed.length > 0) this.addNamedImportPatch(declaration, missingNamed);

    return { changed: this.patches.length > patchesBefore, from: spec.from, added: spec.named };
  }

  private addNamedImportPatch(declaration: t.ImportDeclaration, names: string[]): void {
    const text = names.join(", ");
    const named = declaration.specifiers.filter((item): item is t.ImportSpecifier => t.isImportSpecifier(item));
    const lastNamed = named.at(-1);

    if (lastNamed && typeof lastNamed.end === "number") {
      this.patches.push({ start: lastNamed.end, end: lastNamed.end, text: `, ${text}` });
      return;
    }

    const defaultSpecifier = declaration.specifiers.find((item): item is t.ImportDefaultSpecifier => t.isImportDefaultSpecifier(item));
    if (defaultSpecifier && typeof defaultSpecifier.end === "number") {
      this.patches.push({ start: defaultSpecifier.end, end: defaultSpecifier.end, text: `, { ${text} }` });
      return;
    }

    if (declaration.specifiers.length === 0 || declaration.specifiers.some((item) => t.isImportNamespaceSpecifier(item))) {
      if (typeof declaration.end !== "number") {
        this.disableSourcePatches();
        return;
      }
      this.patches.push({ start: declaration.end, end: declaration.end, text: `\n${buildImportDeclarationText({ from: declaration.source.value, named: names })}` });
      return;
    }

    this.disableSourcePatches();
  }

  private addReplaceExpressionPatch(node: t.JSXExpressionContainer, code: string): void {
    if (typeof node.start !== "number" || typeof node.end !== "number") {
      this.disableSourcePatches();
      return;
    }

    const openBrace = this.source.indexOf("{", node.start);
    const closeBrace = this.source.lastIndexOf("}", node.end - 1);
    if (openBrace < 0 || closeBrace < 0 || closeBrace <= openBrace) {
      this.disableSourcePatches();
      return;
    }
    this.patches.push({ start: openBrace + 1, end: closeBrace, text: code });
  }

  private addInsertChildPatch(
    path: ContainerPath,
    child: t.JSXElement | t.JSXText | t.JSXExpressionContainer | t.JSXFragment,
    position: "append" | "prepend",
  ): void {
    const childText = printNodeCode(child);

    if (path.isJSXElement() && path.node.openingElement.selfClosing) {
      this.addSelfClosingInsertChildPatch(path.node, childText);
      return;
    }

    const boundary = getChildInsertionBoundary(this.source, path.node, position);
    if (!boundary) {
      this.disableSourcePatches();
      return;
    }
    this.patches.push({ start: boundary.start, end: boundary.end, text: boundary.textBefore + childText + boundary.textAfter });
  }

  private addSelfClosingInsertChildPatch(node: t.JSXElement, childText: string): void {
    if (typeof node.openingElement.start !== "number" || typeof node.openingElement.end !== "number") {
      this.disableSourcePatches();
      return;
    }

    const opening = this.source.slice(node.openingElement.start, node.openingElement.end);
    const nextOpening = opening.replace(/\s*\/>$/, ">");
    if (nextOpening === opening) {
      this.disableSourcePatches();
      return;
    }
    this.patches.push({
      start: node.openingElement.start,
      end: node.openingElement.end,
      text: `${nextOpening}${childText}</${jsxNameToString(node.openingElement.name)}>`,
    });
  }

  private addUnwrapPatch(node: ContainerNode): void {
    if (t.isJSXElement(node)) {
      if (node.openingElement.selfClosing) {
        this.addRemoveNodePatch(node);
        return;
      }
      if (
        typeof node.openingElement.start !== "number" ||
        typeof node.openingElement.end !== "number" ||
        !node.closingElement ||
        typeof node.closingElement.start !== "number" ||
        typeof node.closingElement.end !== "number"
      ) {
        this.disableSourcePatches();
        return;
      }

      this.patches.push(
        { start: node.openingElement.start, end: node.openingElement.end, text: "" },
        { start: node.closingElement.start, end: node.closingElement.end, text: "" },
      );
      return;
    }

    if (
      typeof node.openingFragment.start !== "number" ||
      typeof node.openingFragment.end !== "number" ||
      typeof node.closingFragment.start !== "number" ||
      typeof node.closingFragment.end !== "number"
    ) {
      this.disableSourcePatches();
      return;
    }
    this.patches.push(
      { start: node.openingFragment.start, end: node.openingFragment.end, text: "" },
      { start: node.closingFragment.start, end: node.closingFragment.end, text: "" },
    );
  }

  private addRemoveNodePatch(node: IndexedNode): void {
    if (typeof node.start !== "number" || typeof node.end !== "number") {
      this.disableSourcePatches();
      return;
    }

    const span = getStandaloneNodeRemovalSpan(this.source, node.start, node.end);
    this.patches.push({ start: span.start, end: span.end, text: "" });
  }

  private addInsertCommentPatch(path: IndexedPath, text: string, position: CommentPosition): void {
    const commentText = `{/* ${text} */}`;

    if (position === "before" || position === "after") {
      if (typeof path.node.start !== "number" || typeof path.node.end !== "number") {
        this.disableSourcePatches();
        return;
      }
      const point = position === "before" ? path.node.start : path.node.end;
      this.patches.push({ start: point, end: point, text: commentText });
      return;
    }

    const container = this.resolveContainerPath(this.getNodeId(path.node));
    if (container.isJSXElement() && container.node.openingElement.selfClosing) {
      this.addSelfClosingInsertChildPatch(container.node, commentText);
      return;
    }

    const boundary = getChildInsertionBoundary(this.source, container.node, position === "inside-start" ? "prepend" : "append");
    if (!boundary) {
      this.disableSourcePatches();
      return;
    }
    this.patches.push({ start: boundary.start, end: boundary.end, text: boundary.textBefore + commentText + boundary.textAfter });
  }

  private addSetTextPatch(path: ContainerPath, childText: string): void {
    if (path.isJSXElement() && path.node.openingElement.selfClosing) {
      this.addSelfClosingInsertChildPatch(path.node, childText);
      return;
    }

    const range = getChildrenSourceRange(path.node);
    if (!range) {
      this.disableSourcePatches();
      return;
    }
    this.patches.push({ start: range.start, end: range.end, text: childText });
  }

  private addReplaceTextChildPatch(
    child: t.JSXElement["children"][number],
    replacement: t.JSXElement["children"][number],
    value: TextValueSpec,
  ): void {
    if (typeof child.start !== "number" || typeof child.end !== "number") {
      this.disableSourcePatches();
      return;
    }

    const text = t.isJSXText(child) && value.kind === "text"
      ? preserveTextWhitespace(child.value, value.value)
      : printNodeCode(replacement);
    this.patches.push({ start: child.start, end: child.end, text });
  }

  private getExpressionSource(node: t.JSXExpressionContainer): string {
    if (typeof node.start !== "number" || typeof node.end !== "number") return printNodeCode(node.expression);
    const openBrace = this.source.indexOf("{", node.start);
    const closeBrace = this.source.lastIndexOf("}", node.end - 1);
    if (openBrace < 0 || closeBrace < 0 || closeBrace <= openBrace) return printNodeCode(node.expression);
    return this.source.slice(openBrace + 1, closeBrace);
  }

  private getNodeSource(node: t.Node): string {
    if (typeof node.start !== "number" || typeof node.end !== "number") return printNodeCode(node);
    return this.source.slice(node.start, node.end);
  }

  private addNamePatch(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName, text: string): void {
    if (typeof name.start !== "number" || typeof name.end !== "number") {
      this.disableSourcePatches();
      return;
    }
    this.patches.push({ start: name.start, end: name.end, text });
  }

  private addWrapPatches(target: IndexedNode, wrapper: t.JSXElement): void {
    if (typeof target.start !== "number" || typeof target.end !== "number" || !wrapper.closingElement) {
      this.disableSourcePatches();
      return;
    }

    this.patches.push(
      { start: target.start, end: target.start, text: printNodeCode(wrapper.openingElement) },
      { start: target.end, end: target.end, text: printNodeCode(wrapper.closingElement) },
    );
  }

  private addSetAttributePatch(
    openingElement: t.JSXOpeningElement,
    name: string,
    nextAttr: t.JSXAttribute | t.JSXSpreadAttribute,
  ): void {
    const attrText = printNodeCode(nextAttr);
    const existing = findAttribute(openingElement, name);

    if (existing) {
      if (typeof existing.start !== "number" || typeof existing.end !== "number") {
        this.disableSourcePatches();
        return;
      }
      this.patches.push({ start: existing.start, end: existing.end, text: attrText });
      return;
    }

    const insertionPoint = findAttributeInsertionPoint(this.source, openingElement);
    if (insertionPoint === null) {
      this.disableSourcePatches();
      return;
    }
    this.patches.push({ start: insertionPoint, end: insertionPoint, text: formatInsertedAttribute(this.source, insertionPoint, attrText) });
  }

  private addRemoveAttributePatch(openingElement: t.JSXOpeningElement, name: string): void {
    const existing = findAttribute(openingElement, name);
    if (!existing) return;

    if (typeof existing.start !== "number" || typeof existing.end !== "number") {
      this.disableSourcePatches();
      return;
    }

    this.patches.push({
      start: findLeadingWhitespaceStart(this.source, existing.start),
      end: existing.end,
      text: "",
    });
  }

  private disableSourcePatches(): void {
    this.canUseSourcePatches = false;
  }
}

export function openJsxDocument(filePath: string): JsxDocument {
  return new JsxDocument(filePath, readFileSync(filePath, "utf8"));
}

type NormalizedImportSpec = {
  from: string;
  to?: string;
  named: string[];
  defaultName?: string;
  namespace?: string;
  name?: string;
  toName?: string;
};

function normalizeImportSpec(spec: ImportEditSpec): NormalizedImportSpec {
  if (!spec.from) fail("INVALID_IMPORT", "Import edit requires from.");

  const named = normalizeNameList(spec.named);
  if (spec.name && !named.includes(spec.name)) named.push(spec.name);

  return {
    from: spec.from,
    ...(spec.to ? { to: spec.to, toName: spec.to } : {}),
    named,
    ...(spec.default ? { defaultName: spec.default } : {}),
    ...(spec.namespace ? { namespace: spec.namespace } : {}),
    ...(spec.name ? { name: spec.name } : {}),
    ...(typeof spec.value === "string" ? { toName: spec.value } : {}),
  };
}

function normalizeNameList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : value.split(",");
  return items.map((item) => item.trim()).filter(Boolean);
}

function buildImportDeclarationText(spec: Pick<NormalizedImportSpec, "from" | "named" | "defaultName" | "namespace">): string {
  const clauses: string[] = [];
  if (spec.defaultName) clauses.push(spec.defaultName);
  if (spec.namespace) {
    if (spec.named.length > 0) fail("INVALID_IMPORT", "An import cannot mix namespace and named specifiers.");
    clauses.push(`* as ${spec.namespace}`);
  } else if (spec.named.length > 0) {
    clauses.push(`{ ${spec.named.join(", ")} }`);
  }

  if (clauses.length === 0) return `import ${JSON.stringify(spec.from)};`;
  return `import ${clauses.join(", ")} from ${JSON.stringify(spec.from)};`;
}

function buildImportDeclarationFromSpecifiers(from: string, specifiers: t.ImportDeclaration["specifiers"]): string {
  const defaultSpecifier = specifiers.find((item): item is t.ImportDefaultSpecifier => t.isImportDefaultSpecifier(item));
  const namespaceSpecifier = specifiers.find((item): item is t.ImportNamespaceSpecifier => t.isImportNamespaceSpecifier(item));
  const named = specifiers
    .filter((item): item is t.ImportSpecifier => t.isImportSpecifier(item))
    .map(formatImportSpecifier);

  return buildImportDeclarationText({
    from,
    named,
    ...(defaultSpecifier ? { defaultName: defaultSpecifier.local.name } : {}),
    ...(namespaceSpecifier ? { namespace: namespaceSpecifier.local.name } : {}),
  });
}

function formatImportSpecifier(specifier: t.ImportSpecifier): string {
  const imported = importedNameToString(specifier.imported);
  const local = specifier.local.name;
  return imported === local ? imported : `${imported} as ${local}`;
}

function importedNameToString(name: t.ImportSpecifier["imported"]): string {
  return t.isIdentifier(name) ? name.name : name.value;
}

function shouldRemoveImportSpecifier(specifier: t.ImportDeclaration["specifiers"][number], spec: NormalizedImportSpec): boolean {
  if (t.isImportSpecifier(specifier)) {
    const imported = importedNameToString(specifier.imported);
    return spec.named.includes(imported) || spec.named.includes(specifier.local.name);
  }
  if (t.isImportDefaultSpecifier(specifier)) {
    return !!spec.defaultName && specifier.local.name === spec.defaultName;
  }
  if (t.isImportNamespaceSpecifier(specifier)) {
    return !!spec.namespace && specifier.local.name === spec.namespace;
  }
  return false;
}

function addRemoveImportSpecifierPatch(
  patches: SourcePatch[],
  declaration: t.ImportDeclaration,
  specifier: t.ImportDeclaration["specifiers"][number],
): void {
  const index = declaration.specifiers.indexOf(specifier);
  if (index < 0 || typeof specifier.start !== "number" || typeof specifier.end !== "number") return;

  const previous = declaration.specifiers[index - 1];
  const next = declaration.specifiers[index + 1];
  let start = specifier.start;
  let end = specifier.end;

  if (previous && typeof previous.end === "number") {
    start = previous.end;
  } else if (next && typeof next.start === "number") {
    end = next.start;
  }

  patches.push({ start, end, text: "" });
}

function addRenameImportPatch(patches: SourcePatch[], specifier: t.ImportDeclaration["specifiers"][number], fromName: string, toName: string): boolean {
  if (t.isImportSpecifier(specifier)) {
    const imported = importedNameToString(specifier.imported);
    if (imported === fromName && specifier.local.name === fromName) {
      return addNodeTextPatch(patches, specifier, toName);
    }
    if (imported === fromName) return addNodeTextPatch(patches, specifier.imported, toName);
    if (specifier.local.name === fromName) return addNodeTextPatch(patches, specifier.local, toName);
    return false;
  }

  if ((t.isImportDefaultSpecifier(specifier) || t.isImportNamespaceSpecifier(specifier)) && specifier.local.name === fromName) {
    return addNodeTextPatch(patches, specifier.local, toName);
  }

  return false;
}

function addNodeTextPatch(patches: SourcePatch[], node: t.Node, text: string): boolean {
  if (typeof node.start !== "number" || typeof node.end !== "number") return false;
  patches.push({ start: node.start, end: node.end, text });
  return true;
}

function buildChild(spec: ElementSpec): t.JSXElement | t.JSXText | t.JSXExpressionContainer | t.JSXFragment {
  if (spec.text !== undefined) return t.jsxText(spec.text);
  if (spec.comment !== undefined) return buildComment(spec.comment);
  return buildElementNode(spec);
}

function buildTextValueChild(value: TextValueSpec): t.JSXText | t.JSXExpressionContainer {
  if (value.kind === "text") return t.jsxText(value.value);
  return t.jsxExpressionContainer(parseExpressionNode(value.code));
}

function buildElementNode(spec: ElementSpec): t.JSXElement {
  const tag = spec.tag ?? spec.name;
  if (!tag) fail("INVALID_ELEMENT", "Element spec requires a tag or name.");

  const name = buildJsxName(tag);
  const propSource = spec.props ?? spec.attrs ?? spec.attributes ?? {};
  const attributes = Object.entries(propSource).map(([propName, value]) => buildAttribute(propName, value));
  const children = (spec.children ?? []).map((child) => buildChild(child));
  const selfClosing = children.length === 0;

  return t.jsxElement(
    t.jsxOpeningElement(name, attributes, selfClosing),
    selfClosing ? null : t.jsxClosingElement(cloneJsxName(name)),
    children,
    selfClosing,
  );
}

function buildAttribute(name: string, value: PropSpec): t.JSXAttribute | t.JSXSpreadAttribute {
  if (name.startsWith("...")) {
    return t.jsxSpreadAttribute(parseExpressionNode(name.slice(3)));
  }

  if (value && typeof value === "object" && "type" in value && value.type === "spread") {
    return t.jsxSpreadAttribute(parseExpressionNode(value.code));
  }

  const attrName = t.jsxIdentifier(name);

  if (value === true || (value && typeof value === "object" && "type" in value && value.type === "boolean" && value.value)) {
    return t.jsxAttribute(attrName, null);
  }

  if (value === false || value === null || typeof value === "number") {
    return t.jsxAttribute(attrName, t.jsxExpressionContainer(t.valueToNode(value) as t.Expression));
  }

  if (typeof value === "string") {
    return t.jsxAttribute(attrName, t.stringLiteral(value));
  }

  if (value && typeof value === "object" && "type" in value) {
    if (value.type === "string") {
      return t.jsxAttribute(attrName, t.stringLiteral(value.value));
    }
    if (value.type === "expr") {
      return t.jsxAttribute(attrName, t.jsxExpressionContainer(parseExpressionNode(value.code)));
    }
  }

  fail("INVALID_PROP", `Unsupported prop value for "${name}".`);
}

function buildComment(text: string): t.JSXExpressionContainer {
  const expression = t.jsxEmptyExpression();
  (expression as t.JSXEmptyExpression & { comments?: t.Comment[] }).comments = [{ type: "CommentBlock", value: ` ${text} ` }];
  return t.jsxExpressionContainer(expression);
}

function parseExpressionNode(code: string): t.Expression {
  try {
    const expression = parseExpression(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
    if (!t.isExpression(expression)) fail("INVALID_EXPRESSION", `Not an expression: ${code}`);
    return expression;
  } catch (error) {
    fail("INVALID_EXPRESSION", `Invalid expression: ${code}`, error instanceof Error ? error.message : String(error));
  }
}

function textMatchNoneDetails(children: t.JSXElement["children"], match: TextMatchSpec, source: string): Record<string, unknown> {
  const details: Record<string, unknown> = {
    match: describeTextMatch(match),
  };

  if (match.kind !== "text") return details;

  const trimmedRequest = match.value.trim();
  const candidates = children
    .filter((child): child is t.JSXText => t.isJSXText(child) && child.value.trim().length > 0)
    .map((child) => ({
      text: child.value,
      trimmed_text: child.value.trim(),
      ...(child.loc?.start.line ? { line: child.loc.start.line, context: sourceLineContext(source, child.loc.start.line) } : {}),
    }));
  const trimmedMatches = candidates.filter((candidate) => candidate.trimmed_text === trimmedRequest);

  return {
    ...details,
    ...(match.value !== trimmedRequest ? {
      note: "JSX text matching trims leading and trailing whitespace before comparison.",
      trimmed_request: trimmedRequest,
      candidates: trimmedMatches.length > 0 ? trimmedMatches : candidates,
      suggestions: [`Retry with --match-text ${JSON.stringify(trimmedRequest)} if that is the intended target.`],
      next_step_hint: "Remove leading/trailing whitespace from --match-text, or use --match-any for raw child-source matching.",
    } : {
      candidates,
      next_step_hint: "Check direct JSX text children for this selector, or use --match-expr/--match-any for non-text children.",
    }),
  };
}

function sourceLineContext(source: string, line: number): string {
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, line + 1);
  return lines.slice(start, end).map((item, index) => `${start + index + 1}: ${item}`).join("\n");
}

function matchesTextChild(child: t.JSXElement["children"][number], match: TextMatchSpec, source: string): boolean {
  if (match.kind === "text") return t.isJSXText(child) && child.value.trim() === match.value;
  if (match.kind === "expr") {
    return t.isJSXExpressionContainer(child) &&
      !t.isJSXEmptyExpression(child.expression) &&
      normalizeExpressionCode(printNodeCode(child.expression)) === normalizeExpressionCode(match.code);
  }
  return getChildSource(child, source).trim() === match.value;
}

function normalizeExpressionCode(code: string): string {
  return printNodeCode(parseExpressionNode(code));
}

function getChildSource(child: t.JSXElement["children"][number], source: string): string {
  if (typeof child.start === "number" && typeof child.end === "number") return source.slice(child.start, child.end);
  return printNodeCode(child);
}

function describeTextMatch(match: TextMatchSpec): string {
  if (match.kind === "expr") return `expression ${JSON.stringify(match.code)}`;
  return `${match.kind} ${JSON.stringify(match.value)}`;
}

function preserveTextWhitespace(original: string, next: string): string {
  const leading = original.match(/^\s*/)?.[0] ?? "";
  const trailing = original.match(/\s*$/)?.[0] ?? "";
  return `${leading}${next}${trailing}`;
}

function getChildrenSourceRange(node: ContainerNode): SourceRange | null {
  if (t.isJSXElement(node)) {
    if (node.openingElement.selfClosing) return null;
    if (typeof node.openingElement.end !== "number" || !node.closingElement || typeof node.closingElement.start !== "number") {
      return null;
    }
    return { start: node.openingElement.end, end: node.closingElement.start };
  }
  if (typeof node.openingFragment.end !== "number" || typeof node.closingFragment.start !== "number") return null;
  return { start: node.openingFragment.end, end: node.closingFragment.start };
}

function isEmptyAlternate(node: t.Expression): boolean {
  return (
    t.isNullLiteral(node) ||
    (t.isBooleanLiteral(node) && node.value === false) ||
    (t.isIdentifier(node) && node.name === "undefined")
  );
}

function buildJsxName(name: string): t.JSXIdentifier | t.JSXMemberExpression {
  const parts = name.split(".");
  if (parts.length === 1) return t.jsxIdentifier(name);
  return parts.slice(1).reduce<t.JSXIdentifier | t.JSXMemberExpression>((object, property) => {
    return t.jsxMemberExpression(object, t.jsxIdentifier(property));
  }, t.jsxIdentifier(parts[0]));
}

function cloneJsxName(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): typeof name {
  return t.cloneNode(name, true);
}

function jsxNameToString(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`;
  return `${jsxNameToString(name.object)}.${jsxNameToString(name.property)}`;
}

function normalizeClassNames(value: string | string[]): string[] {
  const names = Array.isArray(value) ? value.flatMap(splitClassNames) : splitClassNames(value);
  if (names.length === 0) fail("INVALID_CLASS", "class action requires at least one class name.");
  return names;
}

function splitClassNames(value: string): string[] {
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function uniqueClassNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function findClassAttribute(openingElement: t.JSXOpeningElement): t.JSXAttribute | undefined {
  return findAttribute(openingElement, "className") ?? findAttribute(openingElement, "class");
}

function readStringAttributeValue(attr: t.JSXAttribute): string | null {
  if (attr.value === null) return "";
  if (t.isStringLiteral(attr.value)) return attr.value.value;
  if (t.isJSXExpressionContainer(attr.value) && t.isStringLiteral(attr.value.expression)) {
    return attr.value.expression.value;
  }
  return null;
}

function extractProps(attrs: Array<t.JSXAttribute | t.JSXSpreadAttribute>): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  for (const attr of attrs) {
    if (t.isJSXSpreadAttribute(attr)) {
      props[`...${printNodeCode(attr.argument)}`] = { type: "spread", code: printNodeCode(attr.argument) };
      continue;
    }

    const name = jsxNameToString(attr.name);
    if (attr.value === null) {
      props[name] = true;
    } else if (t.isStringLiteral(attr.value)) {
      props[name] = attr.value.value;
    } else if (t.isJSXExpressionContainer(attr.value)) {
      props[name] = { type: "expr", code: printNodeCode(attr.value.expression) };
    } else {
      props[name] = { type: "unknown" };
    }
  }

  return props;
}

function compactPreview(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function findBaseLiteralCandidates(source: string, selector: string): Array<{ line: number; preview: string }> {
  const literal = selectorLiteralHint(selector);
  if (!literal) return [];
  return source.split(/\r?\n/).flatMap((line, index) => {
    return line.includes(literal) ? [{ line: index + 1, preview: line.trim().slice(0, 160) }] : [];
  }).slice(0, 5);
}

function selectorLiteralHint(selector: string): string | null {
  const quoted = selector.match(/\[[-\w:]+[*^$|~]?=(["'])(.*?)\1\]/);
  if (quoted?.[2]) return quoted[2];
  const tag = selector.match(/[A-Za-z_$][\w$.:-]*/);
  return tag?.[0] ?? null;
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

function findNearestIndexedAncestor(path: NodePath<t.Node>): IndexedPath | null {
  let current = path.parentPath;
  while (current) {
    if (current.isJSXElement() || current.isJSXFragment() || current.isJSXExpressionContainer()) {
      return current as IndexedPath;
    }
    current = current.parentPath;
  }
  return null;
}

function findNearestExpressionContainer(path: NodePath<t.Node>): NodePath<t.JSXExpressionContainer> | null {
  let current = path.parentPath;
  while (current) {
    if (current.isJSXExpressionContainer()) return current;
    current = current.parentPath;
  }
  return null;
}

function findNearestJsxContainerAncestor(path: NodePath<t.Node>): ContainerPath | null {
  let current = path.parentPath;
  while (current) {
    if (current.isJSXElement() || current.isJSXFragment()) return current as ContainerPath;
    current = current.parentPath;
  }
  return null;
}

function findDirectJsxSiblings(path: IndexedPath): IndexedNode[] | null {
  const parent = findSiblingContainer(path);
  if (!parent) return null;
  const siblings = flattenJsxChildren(parent.node.children);
  if (!siblings.some((child) => child === path.node)) return null;
  return siblings;
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

function findSiblingContainer(path: IndexedPath): ContainerPath | null {
  const parent = findNearestJsxContainerAncestor(path);
  if (!parent) return null;
  if (parent.isJSXFragment()) {
    const grandparent = findNearestJsxContainerAncestor(parent);
    if (grandparent && grandparent.node.children.some((child) => child === parent.node)) return grandparent;
  }
  return parent;
}

function flattenJsxChildren(children: ContainerNode["children"]): IndexedNode[] {
  const result: IndexedNode[] = [];
  for (const child of children) {
    if (isWhitespaceText(child)) continue;
    if (t.isJSXFragment(child)) {
      result.push(...flattenJsxChildren(child.children));
    } else if (isIndexableNode(child)) {
      result.push(child);
    }
  }
  return result;
}

function printNodeCode(node: t.Node): string {
  return recast.print(node).code;
}

function findAttribute(openingElement: t.JSXOpeningElement, name: string): t.JSXAttribute | undefined {
  return openingElement.attributes.find((attr): attr is t.JSXAttribute => {
    return t.isJSXAttribute(attr) && jsxNameToString(attr.name) === name;
  });
}

function findAttributeInsertionPoint(source: string, openingElement: t.JSXOpeningElement): number | null {
  if (typeof openingElement.end !== "number") return null;

  let index = openingElement.end - 1;
  while (index >= 0 && /\s/.test(source[index])) index--;
  if (source[index] !== ">") return null;
  if (source[index - 1] === "/") return index - 1;
  return index;
}

function formatInsertedAttribute(source: string, insertionPoint: number, attrText: string): string {
  if (source[insertionPoint] === "/") {
    return /\s/.test(source[insertionPoint - 1] ?? "") ? `${attrText} ` : ` ${attrText} `;
  }
  return ` ${attrText}`;
}

function findLeadingWhitespaceStart(source: string, start: number): number {
  let index = start;
  while (index > 0 && /\s/.test(source[index - 1])) index--;
  return index;
}

function getChildInsertionBoundary(
  source: string,
  node: ContainerNode,
  position: "append" | "prepend",
): { start: number; end: number; textBefore: string; textAfter: string } | null {
  const openEnd = t.isJSXElement(node) ? node.openingElement.end : node.openingFragment.end;
  const closeStart = t.isJSXElement(node) ? node.closingElement?.start : node.closingFragment.start;
  if (typeof openEnd !== "number" || typeof closeStart !== "number") return null;

  if (position === "prepend") {
    const indent = readIndentAfterNewline(source, openEnd);
    if (indent !== null) return { start: openEnd, end: openEnd, textBefore: `\n${indent}`, textAfter: "" };
    return { start: openEnd, end: openEnd, textBefore: "", textAfter: "" };
  }

  const indent = readIndentBeforeToken(source, closeStart);
  if (indent) {
    return {
      start: indent.start,
      end: indent.end,
      textBefore: `${indent.value}  `,
      textAfter: `\n${indent.value}`,
    };
  }
  return { start: closeStart, end: closeStart, textBefore: "", textAfter: "" };
}

function readIndentAfterNewline(source: string, index: number): string | null {
  if (source[index] !== "\n" && source[index] !== "\r") return null;
  let cursor = index;
  if (source[cursor] === "\r") cursor++;
  if (source[cursor] === "\n") cursor++;
  const start = cursor;
  while (cursor < source.length && /[ \t]/.test(source[cursor])) cursor++;
  return source.slice(start, cursor);
}

function readIndentBeforeToken(source: string, tokenStart: number): { start: number; end: number; value: string } | null {
  let cursor = tokenStart;
  while (cursor > 0 && /[ \t]/.test(source[cursor - 1])) cursor--;
  if (cursor === 0 || source[cursor - 1] !== "\n") return null;
  return { start: cursor, end: tokenStart, value: source.slice(cursor, tokenStart) };
}

function getStandaloneNodeRemovalSpan(source: string, start: number, end: number): { start: number; end: number } {
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

function applySourcePatches(source: string, patches: SourcePatch[]): string {
  const ordered = [...patches].sort((a, b) => b.start - a.start);
  let output = source;
  let previousStart = Number.POSITIVE_INFINITY;

  for (const patch of ordered) {
    if (patch.end > previousStart) {
      fail("OVERLAPPING_PATCHES", "Internal source patches overlap.");
    }
    output = `${output.slice(0, patch.start)}${patch.text}${output.slice(patch.end)}`;
    previousStart = patch.start;
  }

  return output;
}
