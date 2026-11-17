import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

// The admin token the CLI and tray send (cli/src/cli/api/client.js derives the
// same value from the same salt and the data directory's cli-secret).
export const CLI_TOKEN_HEADER = "x-9r-cli-token";
export const CLI_TOKEN_SALT = "9r-cli-auth";

let cached: string | null = null;

export async function getCliToken(): Promise<string> {
  if (!cached) cached = await (getConsistentMachineId as unknown as (salt: string) => Promise<string>)(CLI_TOKEN_SALT);
  return cached;
}

export async function isValidCliToken(presented: string | null | undefined): Promise<boolean> {
  if (typeof presented !== "string" || !presented) return false;
  const expected = await getCliToken();
  if (typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
