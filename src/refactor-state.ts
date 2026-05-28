import { existsSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import traverseModule, { type NodePath, type TraverseOptions } from "@babel/traverse";
import * as t from "@babel/types";
import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import { verifyParseForFile } from "./base-edit.js";
import { fail } from "./errors.js";
import { analyzeState, type StateCluster } from "./quality.js";
import { commitWorkspaceUpdates, type WorkspaceFileChange, type WorkspaceFlowOptions } from "./workspace-flow.js";

const traverseAst = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (
  parent: t.Node,
  opts: TraverseOptions,
) => void;

export type RefactorStateOptions = WorkspaceFlowOptions & {
  cluster?: string;
  to?: string;
  name?: string;
  externalDeps?: "fail" | "params";
};

export type RefactorStateResult = {
  success: true;
  file: string;
  cluster: string;
  states: string[];
  state_object: string;
  setter: string;
  mode?: "object-state" | "custom-hook";
  hook_file?: string;
  hook_name?: string;
  hook_object?: string;
  handlers?: string[];
  external_dependencies?: string[];
  parse_verified: boolean;
  parser?: string;
  hook_parse_verified?: boolean;
  hook_parser?: string;
  files: WorkspaceFileChange[];
};

type UseStateBinding = {
  state: string;
  setter: string;
  init: t.Expression | null;
  callee: t.CallExpression["callee"];
  order: number;
};

type HandlerStatement = {
  name: string;
  statement: t.Statement;
};

const SAFE_GLOBALS = new Set([
  "Array",
  "Boolean",
  "Date",
  "JSON",
  "Math",
  "Number",
  "Object",
  "Promise",
  "String",
  "console",
  "undefined",
]);

export function runRefactorState(filePath: string, options: RefactorStateOptions = {}): RefactorStateResult {
  if (options.to || options.name) return runRefactorStateToHook(filePath, options);
  return runRefactorStateInComponent(filePath, options);
}

function runRefactorStateInComponent(filePath: string, options: RefactorStateOptions = {}): RefactorStateResult {
  const source = readFileSync(filePath, "utf8");
  const analysis = analyzeState(filePath, source);
  const cluster = selectCluster(analysis.clusters, options.cluster);
  const ast = parseSource(source);
  const bindings = collectUseStateBindings(ast, cluster.states);
  assertAllBindingsFound(cluster, bindings);

  const stateObject = uniqueName(ast, `${cluster.name}State`, new Set(cluster.states));
  const setter = uniqueName(ast, `set${capitalize(stateObject)}`, new Set(bindings.map((binding) => binding.setter)));
  replaceStateDeclarations(ast, bindings, stateObject, setter);
  rewriteStateUsages(ast, bindings, stateObject, setter);

  const nextSource = recast.print(ast).code;
  const verification = verifyParseForFile(filePath, nextSource);
  const files = commitWorkspaceUpdates([{ file: filePath, source: nextSource }], options);
  return {
    success: true,
    file: filePath,
    cluster: cluster.name,
    states: cluster.states,
    state_object: stateObject,
    setter,
    mode: "object-state",
    parse_verified: verification.verified,
    ...(verification.parser ? { parser: verification.parser } : {}),
    files,
  };
}

function runRefactorStateToHook(filePath: string, options: RefactorStateOptions): RefactorStateResult {
  if (!options.to || !options.name) {
    fail("INVALID_REFACTOR_STATE", "Custom hook extraction requires both --to <file> and --name <hookName>.");
  }
  if (!/^use[A-Z][A-Za-z0-9_]*$/.test(options.name)) {
    fail("INVALID_REFACTOR_STATE", "--name must be a React hook name like useCrewImport.");
  }
  if (existsSync(options.to)) {
    fail("FILE_EXISTS", `refactor-state refuses to overwrite existing hook file: ${options.to}`);
  }

  const source = readFileSync(filePath, "utf8");
  const analysis = analyzeState(filePath, source);
  const cluster = selectCluster(analysis.clusters, options.cluster);
  const ast = parseSource(source);
  const bindings = collectUseStateBindings(ast, cluster.states);
  assertAllBindingsFound(cluster, bindings);

  const stateOwnerNames = collectStateOwnerNames(ast, cluster.states);
  const handlerNames = cluster.handlers.filter((handler) => handler !== "render" && !stateOwnerNames.has(handler));
  const handlers = collectHandlerStatements(ast, handlerNames);
  const externalDependencies = collectHandlerExternalDependencies(handlers, bindings, new Set(handlerNames));
  if (externalDependencies.length > 0 && options.externalDeps !== "params") {
    fail("STATE_REFACTOR_EXTERNAL_DEPENDENCY", "Custom hook extraction found external handler dependencies.", {
      external_dependencies: externalDependencies,
      next_step_hint: "Pass --external-deps params to thread these values into the generated hook, or refactor the handler manually.",
    });
  }

  const hookObject = uniqueName(ast, cluster.name, new Set([...cluster.states, ...handlerNames, ...externalDependencies]));
  const stateObject = uniqueName(ast, `${cluster.name}State`, new Set(cluster.states));
  const setter = uniqueName(ast, `set${capitalize(stateObject)}`, new Set(bindings.map((binding) => binding.setter)));

  replaceStateDeclarationsWithHookCall(ast, bindings, hookObject, options.name, externalDependencies);
  removeHandlerStatements(ast, new Set(handlerNames));
  rewriteSourceReferences(ast, bindings, new Set(handlerNames), hookObject);
  addHookImport(ast, filePath, options.to, options.name);

  const hookSource = buildHookSource(options.name, stateObject, setter, bindings, handlers, externalDependencies);
  const nextSource = recast.print(ast).code;
  const sourceVerification = verifyParseForFile(filePath, nextSource);
  const hookVerification = verifyParseForFile(options.to, hookSource);
  const files = commitWorkspaceUpdates([
    { file: filePath, source: nextSource },
    { file: options.to, source: hookSource },
  ], options);

  return {
    success: true,
    file: filePath,
    cluster: cluster.name,
    states: cluster.states,
    state_object: stateObject,
    setter,
    mode: "custom-hook",
    hook_file: options.to,
    hook_name: options.name,
    hook_object: hookObject,
    handlers: handlerNames,
    ...(externalDependencies.length > 0 ? { external_dependencies: externalDependencies } : {}),
    parse_verified: sourceVerification.verified,
    ...(sourceVerification.parser ? { parser: sourceVerification.parser } : {}),
    hook_parse_verified: hookVerification.verified,
    ...(hookVerification.parser ? { hook_parser: hookVerification.parser } : {}),
    files,
  };
}

function parseSource(source: string): t.File {
  return recast.parse(source, { parser: babelTsParser }) as unknown as t.File;
}

function selectCluster(clusters: StateCluster[], requested?: string): StateCluster {
  if (requested) {
    const cluster = clusters.find((item) => item.name === requested);
    if (!cluster) fail("STATE_CLUSTER_NOT_FOUND", `No state cluster named ${requested}.`, { clusters: clusters.map((item) => item.name) });
    if (cluster.states.length < 2) fail("STATE_REFACTOR_UNSUPPORTED", `Cluster ${requested} contains only one state.`);
    return cluster;
  }
  const cluster = clusters.find((item) => item.recommendation !== "keep-local" && item.states.length > 1);
  if (!cluster) fail("STATE_CLUSTER_NOT_FOUND", "No multi-state cluster is available to refactor.");
  return cluster;
}

function assertAllBindingsFound(cluster: StateCluster, bindings: UseStateBinding[]): void {
  const missing = cluster.states.filter((state) => !bindings.some((binding) => binding.state === state));
  if (missing.length > 0) fail("STATE_REFACTOR_UNSUPPORTED", "Could not locate every useState binding in the selected cluster.", { missing });
}

function collectUseStateBindings(ast: t.File, selectedStates: string[]): UseStateBinding[] {
  const selected = new Set(selectedStates);
  const bindings: UseStateBinding[] = [];
  traverseAst(ast, {
    VariableDeclarator(path) {
      const node = path.node;
      if (!t.isArrayPattern(node.id) || !node.init || !t.isCallExpression(node.init) || !isUseStateCall(node.init)) return;
      const [stateNode, setterNode] = node.id.elements;
      if (!t.isIdentifier(stateNode) || !t.isIdentifier(setterNode) || !selected.has(stateNode.name)) return;
      bindings.push({
        state: stateNode.name,
        setter: setterNode.name,
        init: firstExpressionArg(node.init),
        callee: node.init.callee,
        order: bindings.length,
      });
    },
  });
  return bindings.sort((left, right) => selectedStates.indexOf(left.state) - selectedStates.indexOf(right.state));
}

function collectStateOwnerNames(ast: t.File, selectedStates: string[]): Set<string> {
  const selected = new Set(selectedStates);
  const owners = new Set<string>();
  traverseAst(ast, {
    VariableDeclarator(path) {
      const node = path.node;
      if (!t.isArrayPattern(node.id)) return;
      const stateNode = node.id.elements[0];
      if (!t.isIdentifier(stateNode) || !selected.has(stateNode.name)) return;
      const owner = nearestFunctionName(path);
      if (owner) owners.add(owner);
    },
  });
  return owners;
}

function nearestFunctionName(path: NodePath<t.Node>): string | null {
  let current: NodePath<t.Node> | null = path;
  while (current) {
    if (current.isFunctionDeclaration()) return current.node.id?.name ?? null;
    if (current.isFunctionExpression() || current.isArrowFunctionExpression()) {
      const parent = current.parentPath;
      if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return parent.node.id.name;
      return null;
    }
    current = current.parentPath;
  }
  return null;
}

function collectHandlerStatements(ast: t.File, handlerNames: string[]): HandlerStatement[] {
  const wanted = new Set(handlerNames);
  const handlers = new Map<string, t.Statement>();
  traverseAst(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name || !wanted.has(name) || handlers.has(name)) return;
      handlers.set(name, t.cloneNode(path.node, true));
    },
    VariableDeclaration(path) {
      const matched = path.node.declarations.filter((declaration) => {
        return t.isIdentifier(declaration.id) && wanted.has(declaration.id.name);
      });
      if (matched.length === 0) return;
      if (path.node.declarations.length !== 1 || matched.length !== 1) {
        fail("STATE_REFACTOR_UNSUPPORTED", "Custom hook extraction only supports one handler declarator per declaration.");
      }
      const name = (matched[0].id as t.Identifier).name;
      if (!handlers.has(name)) handlers.set(name, t.cloneNode(path.node, true));
    },
  });
  const missing = handlerNames.filter((name) => !handlers.has(name));
  if (missing.length > 0) {
    fail("STATE_REFACTOR_UNSUPPORTED", "Could not locate every handler needed for custom hook extraction.", { missing });
  }
  return handlerNames.map((name) => ({ name, statement: handlers.get(name) as t.Statement }));
}

function collectHandlerExternalDependencies(handlers: HandlerStatement[], bindings: UseStateBinding[], handlerNames: Set<string>): string[] {
  const allowed = new Set<string>([
    ...SAFE_GLOBALS,
    ...handlerNames,
    ...bindings.map((binding) => binding.state),
    ...bindings.map((binding) => binding.setter),
  ]);

  const dependencies = new Set<string>();
  for (const handler of handlers) {
    const local = collectLocalBindings(handler.statement);
    traverseAst(handler.statement, {
      noScope: true,
      Identifier(path) {
        if (!isReferencedIdentifier(path)) return;
        const name = path.node.name;
        if (allowed.has(name) || local.has(name)) return;
        dependencies.add(name);
      },
    } as TraverseOptions);
  }
  return [...dependencies].sort();
}

function collectLocalBindings(statement: t.Statement): Set<string> {
  const names = new Set<string>();
  const collectFunction = (node: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression): void => {
    for (const param of node.params) collectPatternNames(param, names);
  };

  if (t.isFunctionDeclaration(statement)) {
    if (statement.id) names.add(statement.id.name);
    collectFunction(statement);
  }
  if (t.isVariableDeclaration(statement)) {
    for (const declaration of statement.declarations) {
      collectPatternNames(declaration.id, names);
      if (declaration.init && (t.isFunctionExpression(declaration.init) || t.isArrowFunctionExpression(declaration.init))) {
        collectFunction(declaration.init);
      }
    }
  }

  traverseAst(statement, {
    noScope: true,
    VariableDeclarator(path) {
      collectPatternNames(path.node.id, names);
    },
    FunctionDeclaration(path) {
      if (path.node.id) names.add(path.node.id.name);
      collectFunction(path.node);
    },
    FunctionExpression(path) {
      if (path.node.id) names.add(path.node.id.name);
      collectFunction(path.node);
    },
    ArrowFunctionExpression(path) {
      collectFunction(path.node);
    },
  } as TraverseOptions);
  return names;
}

function collectPatternNames(node: t.Node | null | undefined, names: Set<string>): void {
  if (!node) return;
  if (t.isIdentifier(node)) {
    names.add(node.name);
    return;
  }
  if (t.isRestElement(node)) {
    collectPatternNames(node.argument, names);
    return;
  }
  if (t.isAssignmentPattern(node)) {
    collectPatternNames(node.left, names);
    return;
  }
  if (t.isArrayPattern(node)) {
    for (const element of node.elements) collectPatternNames(element, names);
    return;
  }
  if (t.isObjectPattern(node)) {
    for (const property of node.properties) {
      if (t.isRestElement(property)) collectPatternNames(property.argument, names);
      else if (t.isObjectProperty(property)) collectPatternNames(property.value as t.Node, names);
    }
  }
}

function replaceStateDeclarations(ast: t.File, bindings: UseStateBinding[], stateObject: string, setter: string): void {
  const byState = new Map(bindings.map((binding) => [binding.state, binding]));
  let inserted = false;
  traverseAst(ast, {
    VariableDeclaration(path) {
      const selected = selectedStateDeclarators(path.node, byState);
      if (selected.length === 0) return;
      if (path.node.declarations.length !== 1 || selected.length !== 1) {
        fail("STATE_REFACTOR_UNSUPPORTED", "refactor-state v1 only supports one useState declarator per declaration.");
      }
      if (inserted) {
        path.remove();
        return;
      }
      inserted = true;
      path.replaceWith(t.variableDeclaration(path.node.kind, [buildCombinedStateDeclarator(bindings, stateObject, setter)]));
    },
  });
}

function replaceStateDeclarationsWithHookCall(ast: t.File, bindings: UseStateBinding[], hookObject: string, hookName: string, externalDependencies: string[]): void {
  const byState = new Map(bindings.map((binding) => [binding.state, binding]));
  let inserted = false;
  traverseAst(ast, {
    VariableDeclaration(path) {
      const selected = selectedStateDeclarators(path.node, byState);
      if (selected.length === 0) return;
      if (path.node.declarations.length !== 1 || selected.length !== 1) {
        fail("STATE_REFACTOR_UNSUPPORTED", "Custom hook extraction only supports one useState declarator per declaration.");
      }
      if (inserted) {
        path.remove();
        return;
      }
      inserted = true;
      path.replaceWith(t.variableDeclaration("const", [
        t.variableDeclarator(t.identifier(hookObject), t.callExpression(t.identifier(hookName), externalDependencies.map((name) => t.identifier(name)))),
      ]));
    },
  });
}

function selectedStateDeclarators(node: t.VariableDeclaration, byState: Map<string, UseStateBinding>): t.VariableDeclarator[] {
  return node.declarations.filter((declaration) => {
    if (!t.isArrayPattern(declaration.id)) return false;
    const stateNode = declaration.id.elements[0];
    return t.isIdentifier(stateNode) && byState.has(stateNode.name);
  });
}

function removeHandlerStatements(ast: t.File, handlerNames: Set<string>): void {
  traverseAst(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (name && handlerNames.has(name)) path.remove();
    },
    VariableDeclaration(path) {
      const matched = path.node.declarations.filter((declaration) => t.isIdentifier(declaration.id) && handlerNames.has(declaration.id.name));
      if (matched.length === 0) return;
      if (path.node.declarations.length !== 1 || matched.length !== 1) {
        fail("STATE_REFACTOR_UNSUPPORTED", "Custom hook extraction only supports one handler declarator per declaration.");
      }
      path.remove();
    },
  });
}

function buildCombinedStateDeclarator(bindings: UseStateBinding[], stateObject: string, setter: string): t.VariableDeclarator {
  const properties = bindings.map((binding) => {
    return t.objectProperty(t.identifier(binding.state), binding.init ? t.cloneNode(binding.init) : t.identifier("undefined"));
  });
  return t.variableDeclarator(
    t.arrayPattern([t.identifier(stateObject), t.identifier(setter)]),
    t.callExpression(t.cloneNode(bindings[0].callee), [t.objectExpression(properties)]),
  );
}

function buildHookStateDeclarator(bindings: UseStateBinding[], stateObject: string, setter: string): t.VariableDeclarator {
  const properties = bindings.map((binding) => {
    return t.objectProperty(t.identifier(binding.state), binding.init ? t.cloneNode(binding.init) : t.identifier("undefined"));
  });
  return t.variableDeclarator(
    t.arrayPattern([t.identifier(stateObject), t.identifier(setter)]),
    t.callExpression(t.identifier("useState"), [t.objectExpression(properties)]),
  );
}

function buildHookSource(hookName: string, stateObject: string, setter: string, bindings: UseStateBinding[], handlers: HandlerStatement[], externalDependencies: string[]): string {
  const handlerStatements = handlers.map((handler) => t.cloneNode(handler.statement, true));
  const body: t.Statement[] = [
    t.variableDeclaration("const", [buildHookStateDeclarator(bindings, stateObject, setter)]),
    ...handlerStatements,
    t.returnStatement(t.objectExpression([
      t.spreadElement(t.identifier(stateObject)),
      ...handlers.map((handler) => t.objectProperty(t.identifier(handler.name), t.identifier(handler.name), false, true)),
    ])),
  ];
  const hookAst = t.file(t.program([
    t.importDeclaration([t.importSpecifier(t.identifier("useState"), t.identifier("useState"))], t.stringLiteral("react")),
    t.exportNamedDeclaration(t.functionDeclaration(t.identifier(hookName), externalDependencies.map((name) => t.identifier(name)), t.blockStatement(body)), []),
  ], [], "module"));
  rewriteStateUsages(hookAst, bindings, stateObject, setter);
  return `${recast.print(hookAst).code}\n`;
}

function rewriteStateUsages(ast: t.Node, bindings: UseStateBinding[], stateObject: string, setter: string): void {
  const stateNames = new Set(bindings.map((binding) => binding.state));
  const setterToState = new Map(bindings.map((binding) => [binding.setter, binding.state]));
  traverseAst(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const state = setterToState.get(callee.name);
      if (!state) return;
      const [arg] = path.node.arguments;
      if (!arg || !t.isExpression(arg)) {
        fail("STATE_REFACTOR_UNSUPPORTED", `Setter ${callee.name} must receive one expression argument.`);
      }
      if (t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg)) {
        fail("STATE_REFACTOR_UNSUPPORTED", `Setter ${callee.name} uses a functional update; refactor-state v1 leaves it untouched.`);
      }
      path.replaceWith(buildObjectStateSetterCall(setter, state, rewriteStateReferences(t.cloneNode(arg), stateObject, stateNames)));
      path.skip();
    },
    Identifier(path) {
      if (!isReferencedIdentifier(path) || !stateNames.has(path.node.name)) return;
      path.replaceWith(t.memberExpression(t.identifier(stateObject), t.identifier(path.node.name)));
    },
  });
}

function rewriteSourceReferences(ast: t.File, bindings: UseStateBinding[], handlerNames: Set<string>, hookObject: string): void {
  const stateNames = new Set(bindings.map((binding) => binding.state));
  const setterNames = new Set(bindings.map((binding) => binding.setter));
  traverseAst(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (t.isIdentifier(callee) && setterNames.has(callee.name)) {
        fail("STATE_REFACTOR_UNSUPPORTED", `Setter ${callee.name} remains in the component after custom hook extraction.`);
      }
    },
    Identifier(path) {
      if (!isReferencedIdentifier(path)) return;
      if (stateNames.has(path.node.name) || handlerNames.has(path.node.name)) {
        path.replaceWith(t.memberExpression(t.identifier(hookObject), t.identifier(path.node.name)));
      }
    },
  });
}

function buildObjectStateSetterCall(setter: string, state: string, value: t.Expression): t.CallExpression {
  const previous = t.identifier("previous");
  return t.callExpression(t.identifier(setter), [
    t.arrowFunctionExpression([previous], t.objectExpression([
      t.spreadElement(t.identifier("previous")),
      t.objectProperty(t.identifier(state), value),
    ])),
  ]);
}

function rewriteStateReferences<T extends t.Expression>(node: T, stateObject: string, stateNames: Set<string>): T {
  traverseAst(node, {
    noScope: true,
    Identifier(path) {
      if (!isReferencedIdentifier(path) || !stateNames.has(path.node.name)) return;
      path.replaceWith(t.memberExpression(t.identifier(stateObject), t.identifier(path.node.name)));
    },
  } as TraverseOptions);
  return node;
}

function isReferencedIdentifier(path: NodePath<t.Identifier>): boolean {
  return Boolean(path.parentPath) && path.isReferencedIdentifier();
}

function addHookImport(ast: t.File, sourceFile: string, hookFile: string, hookName: string): void {
  const importPath = hookImportPath(sourceFile, hookFile);
  const exists = ast.program.body.some((statement) => {
    return t.isImportDeclaration(statement) && statement.source.value === importPath && statement.specifiers.some((specifier) => {
      return t.isImportSpecifier(specifier) && t.isIdentifier(specifier.imported, { name: hookName });
    });
  });
  if (exists) return;
  const declaration = t.importDeclaration([t.importSpecifier(t.identifier(hookName), t.identifier(hookName))], t.stringLiteral(importPath));
  let lastImport = -1;
  ast.program.body.forEach((statement, index) => {
    if (t.isImportDeclaration(statement)) lastImport = index;
  });
  ast.program.body.splice(lastImport + 1, 0, declaration);
}

function hookImportPath(sourceFile: string, hookFile: string): string {
  const raw = relative(dirname(sourceFile), hookFile).replace(/\\/g, "/").replace(/\.(tsx?|jsx?)$/, "");
  return raw.startsWith(".") ? raw : `./${raw}`;
}

function uniqueName(ast: t.File, base: string, allowedExisting: Set<string>): string {
  const existing = new Set<string>();
  traverseAst(ast, {
    Identifier(path) {
      existing.add(path.node.name);
    },
  });
  if (!existing.has(base) || allowedExisting.has(base)) return base;
  for (let index = 2; index < 100; index++) {
    const candidate = `${base}${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  fail("STATE_REFACTOR_UNSUPPORTED", `Could not allocate a non-conflicting name from ${base}.`);
}

function firstExpressionArg(node: t.CallExpression): t.Expression | null {
  const [arg] = node.arguments;
  return arg && t.isExpression(arg) ? arg : null;
}

function isUseStateCall(node: t.CallExpression): boolean {
  if (t.isIdentifier(node.callee)) return node.callee.name === "useState";
  return t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: "React" }) &&
    t.isIdentifier(node.callee.property, { name: "useState" });
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}
