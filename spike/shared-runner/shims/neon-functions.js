// Stands in for @neon/functions inside the sandbox.
export const attachDatabasePool = () => {};
export const waitUntil = (p) => void Promise.resolve(p).catch(() => {});
