/** Joins class names, skipping falsy entries. The whole of what a classnames package would do here. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
