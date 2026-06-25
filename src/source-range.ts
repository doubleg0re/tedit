export type SourceOffsetRange = {
  start: number;
  end: number;
};

export type SourceLoc = {
  line: number;
  column: number;
};

export type SourceLocRange = {
  start: SourceLoc;
  end: SourceLoc;
};

export type NodeWithLocOrOffsets = {
  loc?: SourceLocRange | null;
  start?: number | null;
  end?: number | null;
};

export function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function offsetForSourceLoc(loc: SourceLoc, starts: number[]): number {
  return (starts[loc.line - 1] ?? 0) + loc.column;
}

export function sourceRangeForLocOrOffsets(
  node: NodeWithLocOrOffsets,
  starts: number[],
  mapParserOffset: (offset: number) => number = (offset) => offset,
): SourceOffsetRange | null {
  if (node.loc) {
    return {
      start: offsetForSourceLoc(node.loc.start, starts),
      end: offsetForSourceLoc(node.loc.end, starts),
    };
  }
  if (typeof node.start !== "number" || typeof node.end !== "number") return null;
  return { start: mapParserOffset(node.start), end: mapParserOffset(node.end) };
}

export function requireSourceRangeForLocOrOffsets(
  node: NodeWithLocOrOffsets,
  starts: number[],
  code: string,
  fail: (code: string, message: string) => never,
  message = "AST node does not have source offsets.",
): SourceOffsetRange {
  const range = sourceRangeForLocOrOffsets(node, starts);
  if (!range) fail(code, message);
  return range;
}
