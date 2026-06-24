import type { Terminal as XTerm } from "@xterm/xterm";

import { createWriteCoalescer, type WriteCoalescer } from "./writeCoalescer.ts";

const terminalWriteCoalescers = new WeakMap<XTerm, WriteCoalescer>();

export const enqueueCoalescedTerminalWrite = (
  term: XTerm,
  data: string,
  writeNow: (data: string) => void,
): void => {
  let coalescer = terminalWriteCoalescers.get(term);
  if (!coalescer) {
    coalescer = createWriteCoalescer(writeNow);
    terminalWriteCoalescers.set(term, coalescer);
  }
  coalescer.push(data);
};

export const flushTerminalWriteCoalescer = (term: XTerm): void => {
  terminalWriteCoalescers.get(term)?.flushSync();
};

export const resetTerminalWriteCoalescer = (term: XTerm): void => {
  terminalWriteCoalescers.get(term)?.dispose();
  terminalWriteCoalescers.delete(term);
};
