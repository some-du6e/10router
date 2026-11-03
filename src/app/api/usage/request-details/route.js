import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getSettings } from "@/lib/localDb";
import { getProviderLabeler, labelRequestDetail } from "@/lib/requestDetailLabels.js";

const SENSITIVE_DETAIL_KEYS = ["request", "providerRequest", "providerResponse", "response"];

// The list view leaves out the payloads; the drawer loads them by id.
export function summarizeRequestDetails(details) {
  return (details || []).map((detail) => {
    const summary = { ...detail };
    for (const key of SENSITIVE_DETAIL_KEYS) delete summary[key];
    return summary;
  });
}

export function redactRequestDetails(details) {
  return (details || []).map((detail) => {
    const redacted = { ...detail };
    for (const key of SENSITIVE_DETAIL_KEYS) {
      if (redacted[key] !== undefined) {
        redacted[key] = { redacted: true };
      }
    }
    return redacted;
  });
}

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate,
 * summary=1 (omit the request/response payloads)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const [result, settings, labels] = await Promise.all([getRequestDetails(filter), getSettings(), getProviderLabeler()]);
    let details = result.details;
    if (searchParams.get("summary") === "1") details = summarizeRequestDetails(details);
    else if (settings.showSensitiveRequestDetails !== true) details = redactRequestDetails(details);

    return NextResponse.json({ ...result, details: details.map((detail) => labelRequestDetail(detail, labels)) });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
