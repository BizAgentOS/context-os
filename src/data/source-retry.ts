/** Snapshot-only retry for read-only transports that do not already retry requests. */
export async function retrySourceRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) { if (attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt)); }
  }
}
