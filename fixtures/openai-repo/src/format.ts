/** Pure, and the only thing the tests exercise. Unaffected by the upgrade. */
export function summarise(subject: string, queue: string): string {
  return `[${queue}] ${subject.trim()}`;
}
