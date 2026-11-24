import { AWS_DEFAULT_REGION, AWS_REGION_PATTERN, KIRO_PROFILE_ARN_PATTERN } from "../config/awsRegion.js";

export { AWS_DEFAULT_REGION };

export function isValidAwsRegion(region: unknown): region is string {
  return typeof region === "string" && AWS_REGION_PATTERN.test(region);
}

// The stored region when it is a real AWS region, else the default. For every
// place a stored region goes into a hostname (refresh, test, executor).
export function awsRegionOrDefault(region: unknown): string {
  const trimmed = typeof region === "string" ? region.trim() : "";
  return isValidAwsRegion(trimmed) ? trimmed : AWS_DEFAULT_REGION;
}

export function isValidKiroProfileArn(arn: unknown): arn is string {
  return typeof arn === "string" && KIRO_PROFILE_ARN_PATTERN.test(arn);
}

// Why a client-sent Kiro providerSpecificData can't be stored, or null. Only the
// fields it sends are checked, so older stored values don't block other edits.
export function kiroProviderDataProblem(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.region !== undefined && d.region !== null && d.region !== "" && !isValidAwsRegion(d.region)) return "Invalid region";
  if (d.profileArn !== undefined && d.profileArn !== null && d.profileArn !== "" && !isValidKiroProfileArn(d.profileArn)) return "Invalid profileArn";
  return null;
}
