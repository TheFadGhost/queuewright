// Probe: validate option. README says "compile time via generics, runtime if you add `validate`" — no signature given anywhere.
import { defineJob } from "../src/index";

const j1 = defineJob<{ userId: string }>(
  "p.validate",
  {
    validate: (p: { userId: string }) => typeof p.userId === "string",
    maxAttempts: 2,
  },
  async (p) => {
    console.log("ran", p.userId);
  },
);
console.log("defined ok");
