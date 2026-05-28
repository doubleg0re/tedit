export { BaseTreeDocument } from "./core/base-tree-document.js";
export { matchesSimpleSelector, parseSelector, selectorHasScope } from "./core/tree-selector.js";
export type { AttrSelector, ParsedSelector, PseudoSelector, SelectorCombinator, SelectorPart, SimpleSelector } from "./core/tree-selector.js";
export { openDocumentForFile, parseDocumentForFile, getAdapterForFile, getOptionalAdapterForFile, hasAdapterForFile, listRules } from "./core/registry.js";
export { BASE_ACTIONS, parseLineRange, planBaseEdit, verifyParseForFile } from "./base-edit.js";
export type { BaseEditMutation, BaseEditOptions, BaseEditPlan, BaseFindStrategy, BaseMatch, BaseParseVerification } from "./base-edit.js";
export type {
  CommentPosition,
  DocumentAdapter,
  RuleMetadata,
  StructuredDocument,
  TextMatchSpec,
  TextValueSpec,
  TreeNodeInfo,
  TreeNodeSpec,
  ValueSpec,
} from "./core/document.js";
export { JsxDocument, openJsxDocument } from "./rules/jsx/document.js";
export { runFlow, validateFlow } from "./flow.js";
export type { FlowStep, FlowRoot } from "./flow.js";
export { commitWorkspaceUpdates, runWorkspaceFlow } from "./workspace-flow.js";
export type { WorkspaceFileChange, WorkspaceFileUpdate, WorkspaceFlowOptions, WorkspaceFlowResult, WorkspaceFlowStep } from "./workspace-flow.js";
export { parseMultieditInput, runMultiedit, runMultieditInput } from "./multiedit.js";
export type { MultieditResult, MultieditStepResult } from "./multiedit.js";
export { parseApplyPatch, parsePatchInput, parseUnifiedPatch, runPatchInput } from "./patch.js";
export { runRefactorState } from "./refactor-state.js";
export type { ParsedPatchFile, PatchHunk, PatchLine, PatchResult } from "./patch.js";
export type { RefactorStateOptions, RefactorStateResult } from "./refactor-state.js";
export { buildScaffoldSource, loadScaffoldSpec, loadTemplateSpec } from "./scaffold.js";
export type { ScaffoldExportSpec, ScaffoldImportSpec, ScaffoldSpec } from "./scaffold.js";
export { parseExtractSlot, planExtract } from "./extract.js";
export type { ExtractOptions, ExtractPlan, ExtractResult, ExtractSlotSpec } from "./extract.js";
export { analyzeState, fileLengthWarnings, loadQualityConfig } from "./quality.js";
export type { FileLengthThresholds, FileLengthWarning, QualityConfig, StateAnalysis, StateAnalysisGuidance, StateCluster } from "./quality.js";
export { TeditError } from "./errors.js";
export { TEDIT_MCP_TOOL_NAMES, TEDIT_MCP_TOOLS, runMcpTool } from "./mcp-tools.js";
export type { TeditMcpTool } from "./mcp-tools.js";

