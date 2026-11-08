// AWS region names (us-east-1, ap-southeast-2). Regions are interpolated into
// upstream hostnames, so anything else must never reach a URL (GHSA-6mwv-4mrm-5p3m).
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

export function isValidAwsRegion(region: unknown): region is string {
  return typeof region === "string" && AWS_REGION_PATTERN.test(region);
}

// A CodeWhisperer profile ARN. Its region field also ends up in a hostname.
export const KIRO_PROFILE_ARN_PATTERN = /^arn:aws[a-z-]*:codewhisperer:[a-z]{2}-[a-z]+-\d{1,2}:\d{12}:profile\/[A-Za-z0-9]+$/;

export function isValidKiroProfileArn(arn: unknown): arn is string {
  return typeof arn === "string" && KIRO_PROFILE_ARN_PATTERN.test(arn);
}
