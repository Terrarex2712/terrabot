/**
 * Extract sorted, deduplicated {{N}} indices from a string. Returns
 * `[1, 2, 4]` for `"Hi {{1}} {{2}}, item {{4}}"`.
 *
 * Used at actual send time (template-send-builder.ts) to count how
 * many variable values a template's body/header/buttons need. The
 * submission-time validators that used to live here (name/body/
 * footer/header/button/sample-value checks, all specific to Meta's
 * template-creation rules) are gone along with the submit/edit routes
 * they gated — templates are dashboard-managed on AiSensy now.
 */
export function extractVariableIndices(text: string): number[] {
  const matches = text.matchAll(/\{\{(\d+)\}\}/g);
  const set = new Set<number>();
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}
