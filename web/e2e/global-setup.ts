import { startStack } from "./stack";

export default async function globalSetup() {
  await startStack();
}
