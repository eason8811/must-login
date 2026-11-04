/** Promise chain serializing access to Node's process-wide browser globals. */
let lastDomOperation: Promise<void> = Promise.resolve();

/**
 * Execute a task exclusively while a library call owns the global browser DOM.
 *
 * Both Sign and Castle use Happy DOM's global registration, so they must share
 * this lock even when callers invoke their public APIs concurrently.
 *
 * @typeParam T - Value returned by the task.
 * @param task - Asynchronous work requiring exclusive access to browser globals.
 * @returns The resolved result of the task.
 */
export async function withExclusiveDom<T>(task: () => Promise<T>): Promise<T> {
  const previous = lastDomOperation;
  let release: () => void = () => {};
  lastDomOperation = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await task(); }
  finally { release(); }
}
