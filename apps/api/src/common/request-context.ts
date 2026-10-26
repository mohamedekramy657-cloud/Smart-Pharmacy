import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextData {
  requestId: string;
  ipHash?: string;
  userId?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

/** Per-request context (request id, actor) available to services without parameter threading. */
export const requestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },
  get(): RequestContextData | undefined {
    return storage.getStore();
  },
  setUser(userId: string): void {
    const s = storage.getStore();
    if (s) s.userId = userId;
  },
};
