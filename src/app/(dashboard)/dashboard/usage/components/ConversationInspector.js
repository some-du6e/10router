"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Button from "@/shared/components/Button";
import { cn } from "@/shared/utils/cn";
import { getConversation } from "@/shared/utils/requestConversation";
import { renderPromptMarkdown } from "@/shared/utils/requestMarkdown";

const roleStyles = {
  system: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
  developer: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
  user: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  assistant: "bg-blue-500/10 text-blue-600 dark:text-blue-300",
  tool: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  definition: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

function Role({ role }) {
  return (
    <span
      className={cn(
        "inline-block rounded px-2 py-1 text-xs font-medium capitalize",
        roleStyles[role] || "bg-surface-2 text-text-muted",
      )}
    >
      {role === "definition" ? "Tool" : role}
    </span>
  );
}

export default function ConversationInspector({ request, response }) {
  const { messages, tools } = useMemo(
    () => getConversation(request, response),
    [request, response],
  );
  const [section, setSection] = useState("messages");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [role, setRole] = useState("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState("text");
  const [copyStatus, setCopyStatus] = useState("");
  const counts = useMemo(
    () =>
      messages.reduce(
        (acc, message) => ({
          ...acc,
          [message.role]: (acc[message.role] || 0) + 1,
        }),
        {},
      ),
    [messages],
  );
  const entries = section === "tools" ? tools : messages;
  const filtered = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        (section === "tools" || role === "all" || role === entry.role) &&
        (!search ||
          `${entry.text} ${entry.name} ${entry.role}`
            .toLowerCase()
            .includes(search)),
    );
  }, [entries, section, role, deferredQuery]);
  const selected =
    filtered.find((entry) => entry.index === selectedIndex) || filtered[0];
  const position = selected ? filtered.indexOf(selected) : -1;
  const markdown = useMemo(
    () =>
      view === "markdown" && selected
        ? renderPromptMarkdown(selected.text)
        : "",
    [view, selected],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        view === "raw" ? JSON.stringify(selected.raw, null, 2) : selected.text,
      );
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed");
    }
  }

  if (request?.redacted)
    return (
      <p className="rounded-lg bg-amber-500/10 p-4 text-sm text-text-muted">
        Turn on &quot;Show full request details&quot; in Settings to inspect
        prompts.
      </p>
    );
  if (!messages.length && !tools.length)
    return (
      <p className="p-4 text-sm text-text-muted">
        {request?._truncated
          ? "This request only has a raw preview. New large requests retain a structured preview when it fits the storage limit."
          : "No conversation messages or tool definitions were recorded."}
      </p>
    );

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface text-text-main">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle p-4">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={section === "messages" ? "secondary" : "ghost"}
            aria-pressed={section === "messages"}
            onClick={() => {
              setSection("messages");
              setSelectedIndex(0);
              setCopyStatus("");
            }}
          >
            Messages {messages.length}
          </Button>
          <Button
            size="sm"
            variant={section === "tools" ? "secondary" : "ghost"}
            aria-pressed={section === "tools"}
            onClick={() => {
              setSection("tools");
              setSelectedIndex(0);
              setCopyStatus("");
            }}
          >
            Tools {tools.length}
          </Button>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-text-muted">
          {Object.entries(counts).map(([name, count]) => (
            <span key={name} className="flex items-center gap-1.5">
              <Role role={name} />
              {count}
            </span>
          ))}
        </div>
      </div>
      {request?._truncated && (
        <p className="border-b border-border-subtle bg-amber-500/10 px-4 py-2 text-xs text-text-muted">
          Stored preview of a large request. Content marked [Content truncated]
          is incomplete.
        </p>
      )}
      <div className="grid min-w-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 border-b border-border-subtle md:border-b-0 md:border-r">
          <div className="flex gap-2 border-b border-border-subtle p-3">
            <input
              aria-label="Search messages"
              placeholder={
                section === "tools" ? "Search tools..." : "Search messages..."
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCopyStatus("");
              }}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            {section === "messages" && (
              <select
                aria-label="Filter by role"
                value={role}
                onChange={(event) => {
                  setRole(event.target.value);
                  setCopyStatus("");
                }}
                className="min-w-0 rounded-lg border border-border bg-surface px-2 text-xs"
              >
                <option value="all">All roles</option>
                {Object.keys(counts).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex gap-3 bg-surface-2 px-3 py-2 text-xs text-text-muted">
            <span className="w-7">#</span>
            <span className="w-20">Role</span>
            <span>Preview</span>
          </div>
          <div
            className="h-[220px] overflow-auto md:h-[440px]"
            aria-label={
              section === "tools" ? "Tool definitions" : "Conversation messages"
            }
          >
            {filtered.map((entry) => (
              <button
                type="button"
                key={entry.index}
                aria-pressed={selected === entry}
                onClick={() => {
                  setSelectedIndex(entry.index);
                  setCopyStatus("");
                }}
                className={cn(
                  "flex w-full items-start gap-3 border-b border-border-subtle px-3 py-3 text-left hover:bg-surface-2",
                  selected === entry
                    ? "bg-primary/10 shadow-[inset_3px_0_0_var(--color-primary)]"
                    : "",
                )}
              >
                <span className="w-7 shrink-0 pt-1 font-mono text-xs text-text-muted">
                  {entry.index + 1}
                </span>
                <span className="w-20 shrink-0">
                  <Role role={entry.role} />
                </span>
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate">
                    {entry.name ||
                      entry.text.replace(/\s+/g, " ") ||
                      "[No text content]"}
                  </span>
                  {entry.name && (
                    <span className="mt-1 block truncate text-xs text-text-muted">
                      {entry.text.replace(/\s+/g, " ")}
                    </span>
                  )}
                </span>
              </button>
            ))}
            {!filtered.length && (
              <p className="p-6 text-sm text-text-muted">
                No {section} match your search.
              </p>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex min-h-[61px] flex-wrap items-center justify-between gap-2 border-b border-border-subtle p-3">
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                icon="content_copy"
                disabled={!selected}
                onClick={copy}
              >
                {copyStatus || "Copy"}
              </Button>
              {[
                ["text", "Text"],
                ["markdown", "Markdown"],
                ["raw", "Raw JSON"],
              ].map(([mode, label]) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={view === mode ? "secondary" : "ghost"}
                  aria-pressed={view === mode}
                  onClick={() => {
                    setView(mode);
                    setCopyStatus("");
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-xs text-text-muted">
              <Button
                size="sm"
                variant="ghost"
                icon="chevron_left"
                aria-label="Previous message"
                disabled={position <= 0}
                onClick={() => {
                  setSelectedIndex(filtered[position - 1].index);
                  setCopyStatus("");
                }}
              />
              <span>
                {position + 1} of {filtered.length}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="chevron_right"
                aria-label="Next message"
                disabled={position < 0 || position >= filtered.length - 1}
                onClick={() => {
                  setSelectedIndex(filtered[position + 1].index);
                  setCopyStatus("");
                }}
              />
            </div>
          </div>
          <div
            className="h-[360px] overflow-auto p-4 md:h-[474px]"
            aria-label="Selected message content"
          >
            {selected ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <Role role={selected.role} />
                  <span className="break-all font-mono text-xs text-text-muted">
                    {selected.name ||
                      `${section === "tools" ? "Tool" : "Message"} ${selected.index + 1}`}
                  </span>
                </div>
                {view === "markdown" ? (
                  <div
                    className="request-markdown-body break-words text-sm"
                    dangerouslySetInnerHTML={{ __html: markdown }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6">
                    {view === "raw"
                      ? JSON.stringify(selected.raw, null, 2)
                      : selected.text || "[No text content]"}
                  </pre>
                )}
              </>
            ) : (
              <p className="text-sm text-text-muted">
                Select a message to inspect its content.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
