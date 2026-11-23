// Every adapter must release process listeners when its connection is closed.
export function registerShutdown(
  callback: () => void,
  { exitOnSignal = true }: { exitOnSignal?: boolean } = {},
): () => void {
  const onSignal = () => {
    callback();
    if (exitOnSignal) process.exit(0);
  };
  process.once("beforeExit", callback);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("beforeExit", callback);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}
