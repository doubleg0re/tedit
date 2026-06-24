type DiffOp = { kind: "same" | "add" | "remove"; line: string };
type DiffEntry = DiffOp & { oldLine?: number; newLine?: number };

type Hunk = {
  entries: DiffEntry[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

const DEFAULT_CONTEXT_LINES = 3;

export function unifiedDiff(oldText: string, newText: string, filePath = "file", contextLines = DEFAULT_CONTEXT_LINES): string {
  if (oldText === newText) return "";

  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  const entries = annotateLines(diffLines(oldLines, newLines));
  const hunks = buildHunks(entries, Math.max(0, contextLines));
  const body = hunks.flatMap(formatHunk).join("\n");

  return `--- ${filePath}\n+++ ${filePath}\n${body}\n`;
}

function splitTextLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function annotateLines(ops: DiffOp[]): DiffEntry[] {
  let oldLine = 1;
  let newLine = 1;
  return ops.map((op) => {
    if (op.kind === "same") return { ...op, oldLine: oldLine++, newLine: newLine++ };
    if (op.kind === "remove") return { ...op, oldLine: oldLine++ };
    return { ...op, newLine: newLine++ };
  });
}

function buildHunks(entries: DiffEntry[], contextLines: number): Hunk[] {
  const changeIndexes = entries.flatMap((entry, index) => entry.kind === "same" ? [] : [index]);
  const hunks: Hunk[] = [];
  let changeCursor = 0;

  while (changeCursor < changeIndexes.length) {
    let start = Math.max(0, changeIndexes[changeCursor] - contextLines);
    let end = Math.min(entries.length - 1, changeIndexes[changeCursor] + contextLines);
    changeCursor++;

    while (changeCursor < changeIndexes.length && changeIndexes[changeCursor] <= end + contextLines) {
      end = Math.min(entries.length - 1, changeIndexes[changeCursor] + contextLines);
      changeCursor++;
    }

    const slice = entries.slice(start, end + 1);
    hunks.push({ entries: slice, ...hunkRange(entries, start, slice) });
  }

  return hunks;
}

function hunkRange(entries: DiffEntry[], start: number, slice: DiffEntry[]): Omit<Hunk, "entries"> {
  const oldBefore = entries.slice(0, start).filter((entry) => entry.kind !== "add").length;
  const newBefore = entries.slice(0, start).filter((entry) => entry.kind !== "remove").length;
  const oldCount = slice.filter((entry) => entry.kind !== "add").length;
  const newCount = slice.filter((entry) => entry.kind !== "remove").length;
  return {
    oldStart: oldCount === 0 ? oldBefore : oldBefore + 1,
    oldCount,
    newStart: newCount === 0 ? newBefore : newBefore + 1,
    newCount,
  };
}

function formatHunk(hunk: Hunk): string[] {
  return [
    `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    ...hunk.entries.map((entry) => {
      if (entry.kind === "same") return ` ${entry.line}`;
      if (entry.kind === "add") return `+${entry.line}`;
      return `-${entry.line}`;
    }),
  ];
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "remove", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] });
      j++;
    }
  }

  while (i < a.length) {
    ops.push({ kind: "remove", line: a[i] });
    i++;
  }

  while (j < b.length) {
    ops.push({ kind: "add", line: b[j] });
    j++;
  }

  return ops;
}
