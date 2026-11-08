import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

export async function isValidCliToken(presented: string | null | undefined): Promise<boolean> {
  if (typeof presented !== "string" || !presented) return false;
  const expected = await (getConsistentMachineId as unknown as (salt: string) => Promise<string>)(CLI_TOKEN_SALT);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
