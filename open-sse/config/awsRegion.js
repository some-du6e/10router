// AWS region names (us-east-1, ap-southeast-2). Regions are interpolated into
// upstream hostnames, so anything else must never reach a URL (GHSA-6mwv-4mrm-5p3m).
export const AWS_DEFAULT_REGION = "us-east-1";

const REGION = "[a-z]{2}-[a-z]+-\\d{1,2}";

export const AWS_REGION_PATTERN = new RegExp(`^${REGION}$`);

// A CodeWhisperer profile ARN. Its region field also ends up in a hostname.
export const KIRO_PROFILE_ARN_PATTERN = new RegExp(`^arn:aws[a-z-]*:codewhisperer:${REGION}:\\d{12}:profile/[A-Za-z0-9]+$`);
