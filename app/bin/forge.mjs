#!/usr/bin/env node
// Signet CLI launcher. The package ships TypeScript and runs it through tsx's
// ESM loader, so `npx @signet/cli ...` works with no separate build step.
import { register } from "tsx/esm/api";
register();
await import(new URL("../src/cli/index.ts", import.meta.url).href);
