#!/usr/bin/env bun
/**
 * Start the e2e stack and keep it up, for poking at it by hand:
 *
 *   bun e2e/stack-cli.ts          # prints ports and the theo session, waits
 *   Ctrl-C                        # stops everything, removes the temp root
 *
 * E2E_KEEP=1 keeps the temp root. Same switches as the tests (E2E_ENGINE…).
 */
import { startStack, stopStack } from "./stack";

const state = await startStack();
console.log(`api      http://127.0.0.1:${state.apiPort}`);
console.log(`gardens  ${state.gardensDir}`);
console.log(`cookie   maurice_session=${state.sessions.theo}   (theo)`);
console.log(`engine   ${state.engine}`);
const stop = () => { stopStack(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
