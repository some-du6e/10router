"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseQuotaData,
  getQuotaCache,
  setQuotaCache,
  AUTO_REFRESH_STORAGE_KEY,
  REFRESH_INTERVAL_MS,
  CLAUDE_REFRESH_INTERVAL_MS,
} from "./utils";

// Read every metadata page before publishing totals. Quota calls use a small pool
// so large installations do not send hundreds of upstream requests at once.
export async function fetchAllConnections(signal) {
  const connections = new Map();
  for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
    const response = await fetch(
      `/api/providers/client?page=${page}&pageSize=500&accountStatus=all&sort=provider`,
      { signal },
    );
    if (!response.ok)
      throw new Error(
        "Could not load accounts. Your last readings are still shown.",
      );
    const data = await response.json();
    for (const connection of data.connections || [])
      connections.set(connection.id, connection);
    totalPages = data.pagination?.totalPages || 1;
  }
  return [...connections.values()];
}

async function runPool(items, run, signal) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!signal.aborted && index < items.length) await run(items[index++]);
    }),
  );
}

export default function useQuotaDashboard() {
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [now, setNow] = useState(null);
  const controller = useRef(null);
  const refreshingRef = useRef(false);
  const fetchedAt = useRef({});
  const lastReadings = useRef({});
  const inFlight = useRef(new Map());

  const fetchQuota = useCallback(
    async (connection, { force = false, signal } = {}) => {
      if (!signal || signal.aborted) return;
      const previous = inFlight.current.get(connection.id);
      if (previous && !previous.signal.aborted) return previous.promise;
      const task = (async () => {
        // Failed attempts must also respect the provider's polling interval.
        fetchedAt.current[connection.id] = Date.now();
        setLoading((prev) => ({ ...prev, [connection.id]: true }));
        try {
          const response = await fetch(
            `/api/usage/${connection.id}${force ? "?force=1" : ""}`,
            { signal },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok)
            throw new Error(
              data.error || `Quota request failed (${response.status})`,
            );
          const quotas = parseQuotaData(connection.provider, data);
          const hasQuota = quotas.some(
            (q) =>
              !q.message &&
              (q.total > 0 ||
                q.remainingPercentage != null ||
                q.remaining != null ||
                q.unlimited),
          );
          if (
            !hasQuota &&
            lastReadings.current[connection.id]?.quotas?.length
          ) {
            throw new Error(
              data.message || "The provider did not return a quota reading.",
            );
          }
          const updatedAt = new Date().toISOString();
          const entry = {
            quotas: hasQuota ? quotas : [],
            plan: data.plan || null,
            status: data.status || null,
            message: data.message || null,
            updatedAt: hasQuota ? updatedAt : null,
          };
          if (signal.aborted) return;
          fetchedAt.current[connection.id] = Date.now();
          lastReadings.current[connection.id] = entry;
          setQuotaData((prev) => ({ ...prev, [connection.id]: entry }));
          setErrors((prev) => ({ ...prev, [connection.id]: null }));
          setQuotaCache(connection.id, entry);
        } catch (error) {
          if (!signal.aborted)
            setErrors((prev) => ({
              ...prev,
              [connection.id]: error.message || "Could not refresh quota",
            }));
        } finally {
          if (!signal.aborted) {
            setLoading((prev) => ({ ...prev, [connection.id]: false }));
            inFlight.current.delete(connection.id);
          }
        }
      })();
      inFlight.current.set(connection.id, { signal, promise: task });
      return task;
    },
    [],
  );

  const refreshAll = useCallback(
    async (force = false, initial = false) => {
      const signal = controller.current?.signal;
      if (!signal || signal.aborted || refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshing(true);
      try {
        const list = await fetchAllConnections(signal);
        if (signal.aborted) return;
        setConnections(list);
        setConnectionError(null);
        setInitialLoading(false);
        const due = list.filter(
          (connection) =>
            force ||
            initial ||
            Date.now() - (fetchedAt.current[connection.id] || 0) >=
              (connection.provider === "claude"
                ? CLAUDE_REFRESH_INTERVAL_MS
                : REFRESH_INTERVAL_MS),
        );
        await runPool(
          due,
          (connection) => fetchQuota(connection, { force, signal }),
          signal,
        );
      } catch (error) {
        if (!signal.aborted) setConnectionError(error.message);
      } finally {
        if (!signal.aborted) {
          refreshingRef.current = false;
          setRefreshing(false);
          setInitialLoading(false);
        }
      }
    },
    [fetchQuota],
  );

  useEffect(() => {
    controller.current = new AbortController();
    refreshingRef.current = false;
    const stored = getQuotaCache();
    const cached = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    lastReadings.current = cached;
    setQuotaData(cached);
    try {
      setAutoRefresh(
        localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== "false",
      );
    } catch {}
    setNow(Date.now());
    refreshAll(false, true);
    const clock = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      controller.current.abort();
      clearInterval(clock);
    };
  }, [refreshAll]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      if (!document.hidden) refreshAll();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, refreshAll]);

  const toggleAutoRefresh = (value) => {
    setAutoRefresh(value);
    try {
      localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(value));
    } catch {}
  };

  const refreshAccount = (connection) =>
    fetchQuota(connection, { force: true, signal: controller.current?.signal });
  const setAccountActive = async (id, isActive) => {
    const response = await fetch(`/api/providers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
      signal: controller.current?.signal,
    });
    if (!response.ok)
      throw new Error("Could not change account status. Please retry.");
    setConnections((prev) =>
      prev.map((connection) =>
        connection.id === id ? { ...connection, isActive } : connection,
      ),
    );
  };

  return {
    connections,
    quotaData,
    errors,
    loading,
    initialLoading,
    refreshing,
    connectionError,
    autoRefresh,
    now,
    toggleAutoRefresh,
    refreshAll,
    refreshAccount,
    setAccountActive,
  };
}
