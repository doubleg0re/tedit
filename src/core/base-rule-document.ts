import { fail } from "../errors.js";
import { BaseTreeDocument } from "./base-tree-document.js";
import type { CommentPosition, ImportEditSpec, StructuredDocument, TextMatchSpec, TextValueSpec, TreeNodeInfo, TreeNodeSpec, ValueSpec } from "./document.js";

export abstract class BaseRuleDocument<TPath> extends BaseTreeDocument<TPath> implements StructuredDocument {
  private readonly supportedActions: readonly string[];

  protected constructor(ruleName: string, filePath: string, source: string, supportedActions: readonly string[] = []) {
    super(ruleName, filePath, source);
    this.supportedActions = supportedActions;
  }

  abstract print(): string;

  append(_target: string, _spec: TreeNodeSpec): TreeNodeInfo {
    return this.unsupported("append");
  }

  prepend(_target: string, _spec: TreeNodeSpec): TreeNodeInfo {
    return this.unsupported("prepend");
  }

  wrap(_target: string, _wrapper: TreeNodeSpec): TreeNodeInfo {
    return this.unsupported("wrap");
  }

  unwrap(_target: string): TreeNodeInfo | null {
    return this.unsupported("unwrap");
  }

  rename(_target: string, _name: string): TreeNodeInfo {
    return this.unsupported("rename");
  }

  remove(_target: string): void {
    this.unsupported("remove");
  }

  setAttribute(_target: string, _name: string, _value: ValueSpec): TreeNodeInfo {
    return this.unsupported("prop.set");
  }

  removeAttribute(_target: string, _name: string): TreeNodeInfo {
    return this.unsupported("prop.remove");
  }

  addClass(_target: string, _classNames: string | string[]): TreeNodeInfo {
    return this.unsupported("class.add");
  }

  removeClass(_target: string, _classNames: string | string[]): TreeNodeInfo {
    return this.unsupported("class.remove");
  }

  replaceClass(_target: string, _from: string, _to: string): TreeNodeInfo {
    return this.unsupported("class.replace");
  }

  insertComment(_target: string, _text: string, _position?: CommentPosition): TreeNodeInfo {
    return this.unsupported("insertComment");
  }

  setText(_target: string, _value: TextValueSpec): TreeNodeInfo {
    return this.unsupported("text.set");
  }

  replaceText(_target: string, _match: TextMatchSpec, _value: TextValueSpec): TreeNodeInfo {
    return this.unsupported("text.replace");
  }

  addImport(_spec: ImportEditSpec): unknown {
    return this.unsupported("imports.add");
  }

  removeImport(_spec: ImportEditSpec): unknown {
    return this.unsupported("imports.remove");
  }

  renameImport(_spec: ImportEditSpec): unknown {
    return this.unsupported("imports.rename");
  }

  moveImport(_spec: ImportEditSpec): unknown {
    return this.unsupported("imports.move");
  }

  replaceExpression(_target: string, _code: string): TreeNodeInfo {
    return this.unsupported("expr.replace");
  }

  wrapExpression(_target: string, _code: string): TreeNodeInfo {
    return this.unsupported("expr.wrap");
  }

  unwrapExpression(_target: string): TreeNodeInfo {
    return this.unsupported("expr.unwrap");
  }

  toTernaryExpression(_target: string, _alternate?: string): TreeNodeInfo {
    return this.unsupported("expr.toTernary");
  }

  toShortCircuitExpression(_target: string): TreeNodeInfo {
    return this.unsupported("expr.toShortCircuit");
  }

  protected unsupported(action: string): never {
    fail("UNSUPPORTED_ACTION", `${this.ruleName} rule does not support ${action}.`, {
      rule: this.ruleName,
      action,
      supported_actions: this.supportedActions,
    });
  }
}
