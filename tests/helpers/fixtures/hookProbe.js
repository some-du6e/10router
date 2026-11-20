import { useCallback, useEffect, useState } from "react";

export default function HookProbe({ value, log }) {
  const [count, setCount] = useState(0);
  const onValue = useCallback(() => log(`callback ${value}`), [value, log]);
  useEffect(() => {
    log(`effect ${value}`);
    return () => log(`cleanup ${value}`);
  }, [value, log]);
  useEffect(() => {
    log("every render");
  });
  return { onValue, count, setCount };
}
