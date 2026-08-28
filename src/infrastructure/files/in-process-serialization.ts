const queues = new Map<string, (() => void)[]>();
const active = new Set<string>();

async function acquire(key: string): Promise<() => void> {
  if (!active.has(key)) {
    active.add(key);
  } else {
    await new Promise<void>((resolve) => {
      const queue = queues.get(key) ?? [];
      queue.push(resolve);
      queues.set(key, queue);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const queue = queues.get(key);
    const next = queue?.shift();
    if (next !== undefined) {
      if (queue?.length === 0) queues.delete(key);
      next();
      return;
    }
    queues.delete(key);
    active.delete(key);
  };
}

/** Serializes mutations of one shared local store inside this process. The kernel flock remains
 * the cross-process authority; this layer only prevents sibling Agent promises from turning a
 * harmless same-process race into flock's non-blocking `conflict`. */
export async function runWithInProcessSerialization<Value>(
  key: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const release = await acquire(key);
  try {
    return await operation();
  } finally {
    release();
  }
}
