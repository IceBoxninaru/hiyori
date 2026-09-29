// Generation guard for asynchronous model loads: only the latest load may be
// installed; a load that resolves after a newer one began is destroyed on arrival.
export function createLoadGuard() {
  let generation = 0;
  return {
    begin() { return ++generation; },
    isCurrent(token) { return token === generation; },
    // Awaits `promise`; returns its value if still current, otherwise disposes it and returns null.
    async settle(token, promise, dispose) {
      const value = await promise;
      if (token !== generation) { try { dispose(value); } catch { /* ignore */ } return null; }
      return value;
    },
    invalidate() { generation++; },
  };
}
