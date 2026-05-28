type DiffOp = { kind: "same" | "add" | "remove"; line: string };

export function unifiedDiff(oldText: string, newText: string, filePath = "file"): string {
  if (oldText === newText) return "";

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const ops = diffLines(oldLines, newLines);

  const body = ops
    .map((op) => {
      if (op.kind === "same") return ` ${op.line}`;
      if (op.kind === "add") return `+${op.line}`;
      return `-${op.line}`;
    })
    .join("\n");

  return `--- ${filePath}\n+++ ${filePath}\n@@\n${body}\n`;
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

