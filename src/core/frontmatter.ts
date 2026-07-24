export type FrontmatterStatus =
  | { kind: "closed"; end: number }
  | { kind: "unclosed" }
  | { kind: "not-frontmatter" };

// A top-level YAML mapping key: an unindented, whitespace-free token followed by
// a colon (then a space and value, or end of line). Prose that merely contains a
// colon ("다음 상황에서 사용: …") has whitespace before the colon and is excluded,
// so a leading `---` opening prose reads as a thematic break, not frontmatter.
const YAML_KEY_LINE = /^[^\s:#][^\s:]*:(\s.*)?$/;

// A closing fence sits at column 0; an indented `---`/`...` inside a block scalar
// body (description: |) does not close the block.
const CLOSING_FENCE = /^(---|\.\.\.)\s*$/;

// Classify the block opened by a `---` fence on line 1 as closed frontmatter, an
// unclosed frontmatter fence, or a plain thematic break (not-frontmatter). Shared
// by the markdown-lite verifier and the markdown document parser so the two never
// drift on which YAML shapes count as frontmatter.
export function frontmatterStatus(lines: string[]): FrontmatterStatus {
  for (let index = 1; index < lines.length; index++) {
    if (CLOSING_FENCE.test(lines[index] ?? "")) {
      return looksLikeYaml(lines, index) ? { kind: "closed", end: index } : { kind: "not-frontmatter" };
    }
  }
  // No closing fence: frontmatter requires one, so this is an unclosed fence only
  // when the body actually looks like YAML; otherwise line 1 was a thematic break.
  return looksLikeYaml(lines, lines.length) ? { kind: "unclosed" } : { kind: "not-frontmatter" };
}

// Frontmatter bodies open with a top-level key; a thematic break is followed by
// prose or a heading. Block scalar bodies, wrapped continuations, and sequence
// items only ever follow a key, so inspecting the first meaningful line between
// the fences is enough to tell the two apart.
function looksLikeYaml(lines: string[], end: number): boolean {
  for (let index = 1; index < end; index++) {
    const line = (lines[index] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    return YAML_KEY_LINE.test(line);
  }
  return false;
}
