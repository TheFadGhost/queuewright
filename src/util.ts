import { randomBytes } from "node:crypto";

export function newId(prefix: string, when: number): string {
  const t = when.toString(36).padStart(9, "0");
  const r = randomBytes(8).toString("hex");
  return `${prefix}_${t}${r}`;
}

export class FakeClock {
  private current: number;

  constructor(start: number = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(to: number): void {
    this.current = to;
  }
}
