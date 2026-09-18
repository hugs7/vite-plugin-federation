// CJS helper (mirrors use-sync-external-store/shim/with-selector): binds to
// React via require(), which module federation must redirect to the shared
// instance or hooks run against a second copy of React.
'use strict';
var React = require('react');

exports.useSyncExternalStoreWithSelector = function (
  subscribe,
  getSnapshot,
  getServerSnapshot,
  selector,
  isEqual
) {
  var selection = React.useRef(undefined);
  var getSelection = function () {
    var next = selector(getSnapshot());
    if (
      selection.current !== undefined &&
      isEqual &&
      isEqual(selection.current, next)
    ) {
      return selection.current;
    }
    selection.current = next;
    return next;
  };
  return React.useSyncExternalStore(subscribe, getSelection, getSelection);
};

exports.withSelectorReact = React;
