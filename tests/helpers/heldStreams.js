// Shared by the tests and benches that measure what in-flight streams keep in
// memory: a full GC, the heap they count, and a request body as Next hands it
// over.
import v8 from "node:v8";
import vm from "node:vm";

v8.setFlagsFromString("--expose-gc");
export const gc = vm.runInNewContext("gc");

/** A few full GCs, with the timers and microtasks between them run. */
export async function settle() {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The JS heap plus memory held outside it (Buffers). */
export function heap() {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

/**
 * `text` as a request body the way Next hands it over: a stream read off the
 * socket, so the Request holds no copy of its own once it has been read.
 */
export function socketBody(text) {
  let bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    pull(controller) {
      const part = bytes.subarray(0, 64 * 1024);
      bytes = bytes.subarray(part.length);
      controller.enqueue(part.slice());
      if (!bytes.length) {
        bytes = null;
        controller.close();
      }
    },
  });
}
