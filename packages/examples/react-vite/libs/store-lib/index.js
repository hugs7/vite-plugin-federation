// Root entry (mirrors zustand/index): ESM import of react.
import React from 'react';
import { createStore } from './vanilla.js';

export const create = (initializer) => {
  const api = createStore(initializer);
  const useStore = (selector = (s) => s) =>
    React.useSyncExternalStore(
      api.subscribe,
      () => selector(api.getState()),
      () => selector(api.getState())
    );
  return Object.assign(useStore, api);
};

export const storeLibReact = React;
