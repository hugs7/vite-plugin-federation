// Framework-agnostic store (mirrors zustand/vanilla).
export const createStore = (initializer) => {
  let state;
  const listeners = new Set();
  const setState = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    if (Object.is(next, state)) return;
    state = Object.assign({}, state, next);
    listeners.forEach((listener) => listener(state));
  };
  const getState = () => state;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const api = { setState, getState, subscribe };
  state = initializer(setState, getState, api);
  return api;
};
