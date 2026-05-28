import type { TreeNodeInfo } from "./document.js";
import { fail } from "../errors.js";
import { matchesSimpleSelector, parseSelector, selectorHasScope, type ParsedSelector, type SelectorCombinator, type SimpleSelector } from "./tree-selector.js";

export abstract class BaseTreeDocument<TPath> {
  readonly ruleName: string;
  readonly filePath: string;
  readonly source: string;

  private nodeIds = new WeakMap<object, string>();
  protected pathsById = new Map<string, TPath>();
  protected infoById = new Map<string, TreeNodeInfo>();
  private nextId = 1;

  protected constructor(ruleName: string, filePath: string, source: string) {
    this.ruleName = ruleName;
    this.filePath = filePath;
    this.source = source;
  }

  find(selectorInput: string): TreeNodeInfo[] {
    const selector = parseSelector(selectorInput);
    return [...this.pathsById.values()]
      .filter((path) => this.matchesSelectorPath(path, selector))
      .map((path) => this.infoById.get(this.getNodeId(this.nodeForPath(path))))
      .filter((info): info is TreeNodeInfo => !!info);
  }

  inspect(target: string): TreeNodeInfo {
    return this.resolveInfo(target);
  }

  protected abstract nodeForPath(path: TPath): object;
  protected abstract buildInfo(id: string, path: TPath): TreeNodeInfo;
  protected abstract parentPath(path: TPath): TPath | null;
  protected abstract siblingPaths(path: TPath): TPath[];

  protected reindexPaths(paths: Iterable<TPath>): void {
    this.pathsById.clear();
    this.infoById.clear();
    for (const path of paths) this.indexPath(path);
  }

  protected indexPath(path: TPath): void {
    const node = this.nodeForPath(path);
    const id = this.getNodeId(node);
    const info = this.buildInfo(id, path);
    this.pathsById.set(id, path);
    this.infoById.set(id, info);
  }

  protected getNodeId(node: object): string {
    const existing = this.nodeIds.get(node);
    if (existing) return existing;

    const id = `${this.ruleName}_${this.nextId++}`;
    this.nodeIds.set(node, id);
    return id;
  }

  protected pathForNode(node: object): TPath | null {
    return this.pathsById.get(this.getNodeId(node)) ?? null;
  }

  protected resolvePath(target: string): TPath {
    const byId = this.pathsById.get(target);
    if (byId) return byId;

    const matches = this.find(target);
    if (matches.length === 0) {
      fail("NODE_NOT_FOUND", `No ${this.ruleName} node matched "${target}".`, this.nodeNotFoundDetails(target));
    }
    if (matches.length > 1) {
      const selectorCandidates = this.selectorCandidateHints(matches);
      fail("AMBIGUOUS_SELECTOR", `Selector "${target}" matched ${matches.length} nodes. Use --id or a narrower selector.`, {
        rule: this.ruleName,
        selector: target,
        matches: matches.map(({ id, name, loc, preview }) => ({ id, name, loc, preview })),
        selector_candidates: selectorCandidates,
        ...(selectorCandidates.length > 0 ? { next: selectorCandidates.map((candidate) => "Retry with selector " + candidate.selector + ".") } : {}),
        next_step_hint: "Retry with a selector candidate or inspect matches by id before mutating.",
      });
    }

    const path = this.pathsById.get(matches[0].id);
    if (!path) fail("NODE_NOT_FOUND", `Node ${matches[0].id} is no longer available.`);
    return path;
  }

  protected resolveInfo(target: string): TreeNodeInfo {
    const byId = this.infoById.get(target);
    if (byId) return byId;

    const path = this.resolvePath(target);
    const id = this.getNodeId(this.nodeForPath(path));
    const info = this.infoById.get(id);
    if (!info) fail("NODE_NOT_FOUND", `Node ${target} is no longer available.`);
    return info;
  }

  private selectorCandidateHints(matches: TreeNodeInfo[]): Array<Record<string, unknown>> {
    const hints: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const info of matches) {
      for (const selector of stableSelectorsForInfo(info)) {
        if (seen.has(selector)) continue;
        let unique = false;
        try {
          unique = this.find(selector).length === 1;
        } catch {
          unique = false;
        }
        if (!unique) continue;
        seen.add(selector);
        hints.push({ id: info.id, name: info.name, selector, ...(info.loc ? { loc: info.loc } : {}), preview: info.preview });
        break;
      }
      if (hints.length >= 3) break;
    }
    return hints;
  }

  protected nodeNotFoundDetails(target: string): Record<string, unknown> | undefined {
    return {
      rule: this.ruleName,
      selector: target,
      selector_hint: "Supported selector subset: tag, #id, .class, [attr], descendant, >, +, ~, :scope, :has(...), :not(...), :first-child, :last-child, :nth-of-type(n).",
      next_step_hint: `Inspect available nodes with: tedit inspect ${this.filePath} --json, then retry with a broader selector such as * or a known tag.`,
    };
  }

  private matchesSelectorPath(path: TPath, selector: ParsedSelector, partIndex = selector.parts.length - 1): boolean {
    const part = selector.parts[partIndex];
    if (!this.matchesSimplePath(path, part.selector)) return false;
    if (partIndex === 0) return true;

    return this.matchesPriorSelectorPart(path, selector, partIndex - 1, part.combinator ?? "descendant");
  }

  private matchesSimplePath(path: TPath, selector: SimpleSelector, scope?: TPath): boolean {
    const info = this.infoById.get(this.getNodeId(this.nodeForPath(path)));
    if (!info || !matchesSimpleSelector(info, selector)) return false;

    for (const pseudo of selector.pseudos) {
      if (pseudo.kind === "expr") continue;
      if (pseudo.kind === "scope" && (!scope || this.nodeForPath(path) !== this.nodeForPath(scope))) return false;
      if (pseudo.kind === "has" && !this.hasRelativeMatch(path, pseudo.selector)) return false;
      if (pseudo.kind === "not" && this.matchesSelectorPath(path, pseudo.selector)) return false;
      if (pseudo.kind === "first-child" && !this.matchesChildPosition(path, "first")) return false;
      if (pseudo.kind === "last-child" && !this.matchesChildPosition(path, "last")) return false;
      if (pseudo.kind === "nth-of-type" && !this.matchesNthOfType(path, pseudo.index)) return false;
    }

    return true;
  }

  private matchesPriorSelectorPart(path: TPath, selector: ParsedSelector, partIndex: number, combinator: SelectorCombinator): boolean {
    if (combinator === "child") {
      const parent = this.parentPath(path);
      return !!parent && this.matchesSelectorPath(parent, selector, partIndex);
    }

    if (combinator === "adjacent") {
      const previous = this.previousSiblingPath(path);
      return !!previous && this.matchesSelectorPath(previous, selector, partIndex);
    }

    if (combinator === "sibling") {
      return this.previousSiblingPaths(path).some((sibling) => this.matchesSelectorPath(sibling, selector, partIndex));
    }

    let ancestor = this.parentPath(path);
    while (ancestor) {
      if (this.matchesSelectorPath(ancestor, selector, partIndex)) return true;
      ancestor = this.parentPath(ancestor);
    }
    return false;
  }

  private hasRelativeMatch(scope: TPath, selector: ParsedSelector): boolean {
    return [...this.pathsById.values()].some((candidate) => this.matchesRelativeSelectorPath(scope, candidate, selector));
  }

  private matchesRelativeSelectorPath(scope: TPath, path: TPath, selector: ParsedSelector, partIndex = selector.parts.length - 1): boolean {
    const part = selector.parts[partIndex];
    if (!this.matchesSimplePath(path, part.selector, scope)) return false;
    if (partIndex === 0) return this.matchesScopedFirstPart(scope, path, part.combinator, part.selector);

    return this.matchesPriorRelativeSelectorPart(scope, path, selector, partIndex - 1, part.combinator ?? "descendant");
  }

  private matchesPriorRelativeSelectorPart(scope: TPath, path: TPath, selector: ParsedSelector, partIndex: number, combinator: SelectorCombinator): boolean {
    if (combinator === "child") {
      const parent = this.parentPath(path);
      return !!parent && this.matchesRelativeSelectorPath(scope, parent, selector, partIndex);
    }

    if (combinator === "adjacent") {
      const previous = this.previousSiblingPath(path);
      return !!previous && this.matchesRelativeSelectorPath(scope, previous, selector, partIndex);
    }

    if (combinator === "sibling") {
      return this.previousSiblingPaths(path).some((sibling) => this.matchesRelativeSelectorPath(scope, sibling, selector, partIndex));
    }

    let ancestor = this.parentPath(path);
    while (ancestor) {
      if (this.matchesRelativeSelectorPath(scope, ancestor, selector, partIndex)) return true;
      ancestor = this.parentPath(ancestor);
    }
    return false;
  }

  private matchesScopedFirstPart(scope: TPath, path: TPath, combinator: SelectorCombinator | undefined, selector: SimpleSelector): boolean {
    if (combinator === "child") {
      const parent = this.parentPath(path);
      return !!parent && this.nodeForPath(parent) === this.nodeForPath(scope);
    }

    if (combinator === "adjacent") {
      const previous = this.previousSiblingPath(path);
      return !!previous && this.nodeForPath(previous) === this.nodeForPath(scope);
    }

    if (combinator === "sibling") {
      return this.previousSiblingPaths(path).some((sibling) => this.nodeForPath(sibling) === this.nodeForPath(scope));
    }

    if (selectorHasScope(selector)) return this.nodeForPath(path) === this.nodeForPath(scope);
    return this.isDescendantOf(path, scope);
  }

  private isDescendantOf(path: TPath, scope: TPath): boolean {
    let ancestor = this.parentPath(path);
    while (ancestor) {
      if (this.nodeForPath(ancestor) === this.nodeForPath(scope)) return true;
      ancestor = this.parentPath(ancestor);
    }
    return false;
  }

  private previousSiblingPath(path: TPath): TPath | null {
    return this.previousSiblingPaths(path)[0] ?? null;
  }

  private previousSiblingPaths(path: TPath): TPath[] {
    const siblings = this.siblingPaths(path);
    const index = siblings.findIndex((sibling) => this.nodeForPath(sibling) === this.nodeForPath(path));
    if (index <= 0) return [];
    return siblings.slice(0, index).reverse();
  }

  private matchesChildPosition(path: TPath, position: "first" | "last"): boolean {
    const siblings = this.siblingPaths(path);
    const index = siblings.findIndex((sibling) => this.nodeForPath(sibling) === this.nodeForPath(path));
    if (index < 0) return false;
    return position === "first" ? index === 0 : index === siblings.length - 1;
  }

  private matchesNthOfType(path: TPath, index: number): boolean {
    const info = this.infoById.get(this.getNodeId(this.nodeForPath(path)));
    if (!info) return false;
    const sameType = this.siblingPaths(path).filter((sibling) => {
      const siblingInfo = this.infoById.get(this.getNodeId(this.nodeForPath(sibling)));
      return siblingInfo?.kind === info.kind && siblingInfo.name === info.name;
    });
    return sameType[index - 1] !== undefined && this.nodeForPath(sameType[index - 1]) === this.nodeForPath(path);
  }
}

function stableSelectorsForInfo(info: TreeNodeInfo): string[] {
  const attrs = info.attributes ?? {};
  const selectors: string[] = [];
  const id = comparableAttr(attrs.id);
  if (id) selectors.push(simpleCssIdent(id) ? "#" + id : info.name + "[id=" + JSON.stringify(id) + "]");

  const classValue = comparableAttr(attrs.className) ?? comparableAttr(attrs.class);
  if (classValue) {
    for (const className of classValue.split(/\\s+/).filter(Boolean)) {
      if (simpleCssIdent(className)) selectors.push(info.name + "." + className);
    }
  }

  for (const attr of ["data-testid", "data-test", "aria-label", "name", "role"]) {
    const value = comparableAttr(attrs[attr]);
    if (value) selectors.push(info.name + "[" + attr + "=" + JSON.stringify(value) + "]");
  }

  return selectors;
}

function comparableAttr(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function simpleCssIdent(value: string): boolean {
  return /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(value);
}
