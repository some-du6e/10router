"use client";

import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import ConversationInspector, { FullPayloadNotice } from "./ConversationInspector";

// Page 1 re-fetches on this interval while auto-refresh is on.
const LIVE_REFRESH_MS = 5000;

function CollapsibleSection({ title, children, defaultOpen = false, icon = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  
  return (
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <button 
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon && <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-text-muted">{icon}</span>}
          <span className="font-semibold text-sm text-text-main">{title}</span>
        </div>
        <span className={cn(
          "material-symbols-outlined text-[20px] text-text-muted transition-transform duration-200",
          isOpen ? "rotate-90" : ""
        )} aria-hidden="true">
          chevron_right
        </span>
      </button>
      
      {isOpen && (
        <div className="p-4 border-t border-black/5 dark:border-white/5">
          {children}
        </div>
      )}
    </div>
  );
}

// The upstream key (provider connection) that served the request. A deleted
// key keeps only its id.
function KeyLabel({ detail }) {
  if (detail.connectionName) return detail.connectionName;
  if (detail.connectionId) return <span className="font-mono text-text-muted">{detail.connectionId.slice(0, 8)}</span>;
  return <span className="text-text-muted">—</span>;
}

function StatusLabel({ detail }) {
  if (detail.status === "error") {
    return <span className="font-medium text-red-600" title={detail.errorClass || undefined}>Error</span>;
  }
  return <span className="text-green-600">OK</span>;
}

function getCachedTokens(tokens) {
  return tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
}

function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}

function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  // Canonical storage keeps prompt cache-inclusive. Legacy Claude rows may have
  // stored prompt cache-exclusive; fall back to cache when it's larger so old
  // rows don't under-report input.
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

function isTruncatedPayload(value) {
  return value && typeof value === "object" && value._truncated === true;
}

function formatPayload(value, emptyLabel = "[No data]") {
  if (isTruncatedPayload(value)) {
    const size = Number.isFinite(value._originalSize)
      ? ` (${Math.ceil(value._originalSize / 1024)} KB before truncation)`
      : "";
    const preview = value._structuredPreview
      ? JSON.stringify(value._structuredPreview, null, 2)
      : value._preview || "[No preview available]";
    return `[Payload truncated${size}. Only a preview was retained.]\n\n${preview}`;
  }
  if (typeof value === "string") return value || emptyLabel;
  if (value === undefined || value === null) return emptyLabel;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Payload could not be displayed]";
  }
}

// Pretty-printing a multi-MB payload is slow, so do it once per payload, not
// on every drawer render.
const PayloadPre = memo(function PayloadPre({ value, className }) {
  const text = useMemo(() => formatPayload(value), [value]);
  return <pre className={className}>{text}</pre>;
});

export default function RequestDetailsTab() {
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0
  });
  const [loading, setLoading] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [requestView, setRequestView] = useState("conversation");
  const [fullState, setFullState] = useState({ loading: false, error: "" });
  const [fullController, setFullController] = useState(null);
  const [detailState, setDetailState] = useState({ loading: false, error: "" });
  const detailControllerRef = useRef(null);
  const listRequestRef = useRef(0);
  const [live, setLive] = useState(true);
  const [providers, setProviders] = useState([]);
  const [filters, setFilters] = useState({
    provider: "",
    startDate: "",
    endDate: ""
  });

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/providers");
      const data = await res.json();
      setProviders(data.providers || []);
    } catch (error) {
      console.error("Failed to fetch providers:", error);
    }
  }, []);

  // A silent fetch (auto-refresh) keeps the current rows on screen instead of
  // swapping in the loading row.
  const fetchDetails = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++listRequestRef.current;
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
        summary: "1"
      });
      if (filters.provider) params.append("provider", filters.provider);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);

      const res = await fetch(`/api/usage/request-details?${params}`);
      const data = await res.json();
      // A newer fetch (filter change, later poll) already owns the table.
      if (requestId !== listRequestRef.current) return;
      if (!res.ok) throw new Error(data?.error || `Failed to fetch request details (${res.status})`);

      setDetails(data.details || []);
      setPagination(prev => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch request details:", error);
    } finally {
      if (requestId === listRequestRef.current) setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters]);

  const liveActive = live && pagination.page === 1;

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  // Only page 1 follows new requests; deeper pages would shift under the reader.
  useEffect(() => {
    if (!liveActive) return;
    const refresh = () => {
      if (document.visibilityState === "visible") fetchDetails({ silent: true });
    };
    const timer = setInterval(refresh, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [liveActive, fetchDetails]);

  // The list carries no payloads; fetch this request's on open.
  const handleViewDetail = async (detail) => {
    fullController?.abort();
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setSelectedDetail(detail);
    setFullState({ loading: false, error: "" });
    setDetailState({ loading: true, error: "" });
    setRequestView("conversation");
    setIsDrawerOpen(true);
    try {
      const res = await fetch(`/api/usage/request-details/${encodeURIComponent(detail.id)}`, { signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!res.ok || !data) throw new Error(data?.error || `Failed to load request (${res.status})`);
      setSelectedDetail(prev => (prev?.id === detail.id ? { ...prev, ...data } : prev));
      setDetailState({ loading: false, error: "" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setDetailState({ loading: false, error: error.message });
    }
  };

  const handlePageChange = (newPage) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handlePageSizeChange = (newPageSize) => {
    setPagination(prev => ({ ...prev, pageSize: newPageSize, page: 1 }));
  };

  const handleClearFilters = () => {
    setFilters({ provider: "", startDate: "", endDate: "" });
  };

  const requestIsTruncated = isTruncatedPayload(selectedDetail?.request);

  // Swap the stored previews for the untruncated payloads kept server-side.
  const loadFullPayload = async () => {
    const id = selectedDetail?.id;
    if (!id) return;
    fullController?.abort();
    const controller = new AbortController();
    setFullController(controller);
    setFullState({ loading: true, error: "" });
    try {
      const res = await fetch(`/api/usage/request-details/${encodeURIComponent(id)}/full`, { signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        // Evicted or turned off: stop offering a button that can't succeed.
        if (res.status === 403 || res.status === 404) {
          const unmark = (detail) => (detail.id === id ? { ...detail, hasFullData: false } : detail);
          setSelectedDetail(prev => (prev ? unmark(prev) : prev));
          setDetails(prev => prev.map(unmark));
        }
        throw new Error(data?.error || `Failed to load full payload (${res.status})`);
      }
      if (!data || typeof data !== "object") throw new Error("The server sent an unreadable full payload");
      const merge = (detail) => (detail.id === id ? { ...detail, ...data, hasFullData: false } : detail);
      // Only the open request gets the full payload; the list keeps its previews.
      setSelectedDetail(prev => (prev ? merge(prev) : prev));
      setFullState({ loading: false, error: "" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setFullState({ loading: false, error: error.message });
    }
  };
  const fullPayload = selectedDetail
    ? { available: selectedDetail.hasFullData === true, load: loadFullPayload, ...fullState }
    : null;
  const anyPayloadTruncated = ["request", "providerRequest", "providerResponse", "response"]
    .some((key) => isTruncatedPayload(selectedDetail?.[key]));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="provider-filter" className="text-sm font-medium text-text-main">Provider</label>
            <select
              id="provider-filter"
              value={filters.provider}
              onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-full min-w-0 cursor-pointer"
              )}
              style={{ colorScheme: 'auto' }}
            >
              <option value="">All Providers</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
          
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="start-date-filter" className="text-sm font-medium text-text-main">Start Date</label>
            <input
              id="start-date-filter"
              type="datetime-local"
              value={filters.startDate}
              onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              )}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="end-date-filter" className="text-sm font-medium text-text-main">End Date</label>
            <input
              id="end-date-filter"
              type="datetime-local"
              value={filters.endDate}
              onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              )}
            />
          </div>
          
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-1">
            <span className="hidden text-sm font-medium text-text-main opacity-0 lg:block" aria-hidden="true">Clear</span>
            <Button 
              variant="ghost" 
              onClick={handleClearFilters}
              disabled={!filters.provider && !filters.startDate && !filters.endDate}
              className="w-full"
            >
              Clear Filters
            </Button>
          </div>
        </div>
      </Card>

      <Card padding="none">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 px-4 py-2 dark:border-white/5">
          <span className="text-xs text-text-muted">
            {pagination.totalItems.toLocaleString()} requests
            {live && pagination.page !== 1 && " · auto-refresh follows page 1"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={live ? "pause" : "play_arrow"}
            aria-pressed={live}
            onClick={() => setLive(value => !value)}
          >
            {live ? "Auto-refresh on" : "Auto-refresh off"}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left p-4 text-sm font-semibold text-text-main">Timestamp</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Model</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Provider</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Key</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Status</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Input Tokens</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cached</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cache Creation</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Output Tokens</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Latency</th>
                <th className="text-center p-4 text-sm font-semibold text-text-main">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="11" className="p-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                      Loading...
                    </div>
                  </td>
                </tr>
              ) : details.length === 0 ? (
                <tr>
                  <td colSpan="11" className="p-8 text-center text-text-muted">
                    No request details found
                  </td>
                </tr>
              ) : (
                details.map((detail, index) => (
                  <tr
                    key={`${detail.id}-${index}`}
                    className="border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="whitespace-nowrap p-4 text-sm text-text-main">
                      {new Date(detail.timestamp).toLocaleString()}
                    </td>
                    <td className="max-w-[260px] truncate p-4 font-mono text-sm text-text-main">
                      {detail.model}
                    </td>
                    <td className="max-w-[180px] truncate p-4 text-sm text-text-main" title={detail.provider}>
                      <span className="font-medium">{detail.providerName || detail.provider}</span>
                    </td>
                    <td className="max-w-[160px] truncate p-4 text-sm text-text-main" title={detail.connectionId || undefined}>
                      <KeyLabel detail={detail} />
                    </td>
                    <td className="p-4 text-sm">
                      <StatusLabel detail={detail} />
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getInputTokens(detail.tokens).toLocaleString()}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getCachedTokens(detail.tokens) > 0 ? getCachedTokens(detail.tokens).toLocaleString() : "—"}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getCacheCreationTokens(detail.tokens) > 0 ? getCacheCreationTokens(detail.tokens).toLocaleString() : "—"}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {detail.tokens?.completion_tokens?.toLocaleString() || 0}
                    </td>
                    <td className="p-4 text-sm text-text-muted">
                      <div className="flex flex-col gap-0.5">
                        <div>TTFT: <span className="font-mono">{detail.latency?.ttft || 0}ms</span></div>
                        <div>Total: <span className="font-mono">{detail.latency?.total || 0}ms</span></div>
                      </div>
                    </td>
                    <td className="p-4 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleViewDetail(detail)}
                      >
                        Detail
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && details.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </Card>

      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => {
          fullController?.abort();
          detailControllerRef.current?.abort();
          setIsDrawerOpen(false);
        }}
        title="Request Details"
        width="full"
        className="max-w-[1440px]"
      >
        {selectedDetail && (
          <div className="space-y-6">
            <div className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-text-muted">ID:</span>{" "}
                <span className="break-all font-mono text-text-main">{selectedDetail.id}</span>
              </div>
              <div>
                <span className="text-text-muted">Timestamp:</span>{" "}
                <span className="text-text-main">{new Date(selectedDetail.timestamp).toLocaleString()}</span>
              </div>
              <div>
                 <span className="text-text-muted">Provider:</span>{" "}
                <span className="text-text-main font-medium">{selectedDetail.providerName || selectedDetail.provider}</span>
              </div>
              <div>
                <span className="text-text-muted">Key:</span>{" "}
                <span className="text-text-main font-medium" title={selectedDetail.connectionId || undefined}>
                  <KeyLabel detail={selectedDetail} />
                </span>
              </div>
              <div>
                <span className="text-text-muted">Model:</span>{" "}
                <span className="text-text-main font-mono">{selectedDetail.model}</span>
              </div>
              <div>
                <span className="text-text-muted">Status:</span>{" "}
                <span className={cn(
                  "font-medium",
                  selectedDetail.status === "success" ? "text-green-600" : "text-red-600"
                )}>
                  {selectedDetail.status}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Latency:</span>{" "}
                <span className="text-text-main font-mono">
                  TTFT {selectedDetail.latency?.ttft || 0}ms / Total {selectedDetail.latency?.total || 0}ms
                </span>
              </div>
              <div>
                <span className="text-text-muted">Input Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {getInputTokens(selectedDetail.tokens).toLocaleString()}
                </span>
              </div>
              {getCachedTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cached Tokens:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCachedTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              {getCacheCreationTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cache Creation:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCacheCreationTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              <div>
                <span className="text-text-muted">Output Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {selectedDetail.tokens?.completion_tokens?.toLocaleString() || 0}
                </span>
              </div>
            </div>

            {detailState.loading || detailState.error ? (
              <div className={cn("flex items-center gap-2 rounded-lg border border-border-subtle p-6 text-sm", detailState.error ? "text-red-600" : "text-text-muted")}>
                {detailState.error || (
                  <>
                    <span className="material-symbols-outlined animate-spin text-[20px]" aria-hidden="true">progress_activity</span>
                    Loading request...
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <CollapsibleSection title="Conversation" defaultOpen={true} icon="forum">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-text-muted">Client messages and the assistant response</span>
                    <div className="flex gap-2">
                      <Button variant={requestView === "conversation" ? "secondary" : "ghost"} size="sm" icon="forum" aria-pressed={requestView === "conversation"} onClick={() => setRequestView("conversation")}>Conversation</Button>
                      <Button variant={requestView === "raw" ? "secondary" : "ghost"} size="sm" icon="data_object" aria-pressed={requestView === "raw"} onClick={() => setRequestView("raw")}>Raw JSON</Button>
                    </div>
                  </div>
                  {requestView === "conversation" ? (
                    <ConversationInspector key={selectedDetail.id} request={selectedDetail.request} response={selectedDetail.response} fullPayload={fullPayload} />
                  ) : (
                    <>
                      {requestIsTruncated && (
                        <div className="mb-3 flex flex-wrap items-center justify-end gap-2 text-xs">
                          <FullPayloadNotice fullPayload={fullPayload} className="text-text-muted" />
                        </div>
                      )}
                      {selectedDetail.request?.redacted ? (
                        <pre className="max-h-[540px] max-w-full overflow-auto rounded-lg border border-border-subtle bg-surface-2 p-4 font-mono text-xs text-text-main">[Request redacted. Enable &quot;Show full request details&quot; in Settings.]</pre>
                      ) : (
                        <PayloadPre value={selectedDetail.request} className={cn("max-h-[540px] max-w-full overflow-auto rounded-lg border p-4 font-mono text-xs text-text-main", requestIsTruncated ? "border-amber-500/20 bg-amber-500/10" : "border-border-subtle bg-surface-2")} />
                      )}
                    </>
                  )}
                </CollapsibleSection>
  
                <CollapsibleSection key={selectedDetail.id} title="Debug" icon="bug_report">
                  <p className="mb-4 text-xs text-text-muted">Stored payloads for inspecting translation and provider behavior.</p>
                  {anyPayloadTruncated && (
                    <div className="mb-4 text-xs text-text-muted">
                      <FullPayloadNotice fullPayload={fullPayload} label="Load full payloads" className="" />
                    </div>
                  )}
                  {[
                    ["Provider request", selectedDetail.providerRequest],
                    ["Provider response", selectedDetail.providerResponse],
                    ["Client response", selectedDetail.response],
                  ].filter(([, payload]) => payload).map(([title, payload]) => (
                    <div key={title} className="mb-4 last:mb-0">
                      <h4 className="mb-2 text-xs font-semibold text-text-muted">{title}</h4>
                      <PayloadPre value={payload} className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-border-subtle bg-surface-2 p-4 font-mono text-xs text-text-main" />
                    </div>
                  ))}
                </CollapsibleSection>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
