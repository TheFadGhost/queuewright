export function spin(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    Math.sqrt(Date.now());
  }
}

export function fastDouble(n: number): number {
  return n * 2;
}
