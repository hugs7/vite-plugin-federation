// Sub-path entry (mirrors zustand/traditional): lives inside the shared
// package's directory but is not itself the shared entry, so a remote build
// bundles it locally. Its `react` import must still resolve to the shared
// instance, as must the CJS helper's require('react').
import React from 'react';
import { useSyncExternalStoreWithSelector, withSelectorReact } from './with-selector.cjs';
import { createStore } from './vanilla.js';

export const createWithEqualityFn = (initializer, isEqual = Object.is) => {
  const api = createStore(initializer);
  const useStore = (selector = (s) => s) =>
    useSyncExternalStoreWithSelector(
      api.subscribe,
      api.getState,
      api.getState,
      selector,
      isEqual
    );
  return Object.assign(useStore, api);
};

export const traditionalReact = React;
export { withSelectorReact };
