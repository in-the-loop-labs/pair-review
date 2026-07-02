// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Guarantee a working `localStorage`/`sessionStorage` in jsdom test files.
//
// Node 22.4+ (flagged) and Node 26 (default-on) expose the Web Storage API as
// a global. That global exists *before* vitest builds the jsdom environment,
// so vitest's `populateGlobal` sees `'localStorage' in globalThis` is already
// true and — because `localStorage` is not in its protected key list — skips
// copying jsdom's real `localStorage` onto the global. The remaining native
// accessor is unconfigured, so `window.localStorage` reads back as `undefined`
// (Node 26) or throws (`--experimental-webstorage` on 24), and any jsdom test
// that touches ambient `localStorage` blows up with
// `Cannot read properties of undefined (reading 'clear')`.
//
// This ran green on Node 24 (no native global) and red on Node 26, which is
// how adding Node 26 to the CI matrix surfaced it. Installing our own
// configurable in-memory Storage below is Node-version-agnostic and
// deterministic. Node-environment test files have no `window` and are skipped;
// they keep managing `global.localStorage` themselves.

if (typeof window !== 'undefined') {
  const makeStorage = () => {
    const store = new Map();
    const api = {
      getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
      setItem: (key, value) => { store.set(String(key), String(value)); },
      removeItem: (key) => { store.delete(String(key)); },
      clear: () => { store.clear(); },
      key: (index) => {
        const keys = [...store.keys()];
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
      get length() { return store.size; },
    };
    // Real Storage also supports property/bracket access that stays in sync with
    // the store (`localStorage.theme = 'dark'` <-> `getItem('theme')`). Route
    // unknown string keys to the method API so a test that writes one way and
    // reads the other doesn't silently diverge. Symbol keys (Symbol.toPrimitive,
    // util.inspect.custom, etc.) fall through untouched so framework internals
    // probing the object aren't misrouted into the store.
    return new Proxy(api, {
      get: (t, prop) => (typeof prop === 'symbol' || prop in t ? t[prop] : t.getItem(prop)),
      set: (t, prop, value) => (typeof prop === 'symbol' ? (t[prop] = value) : t.setItem(prop, value), true),
      deleteProperty: (t, prop) => (typeof prop === 'symbol' ? delete t[prop] : t.removeItem(prop), true),
    });
  };

  for (const name of ['localStorage', 'sessionStorage']) {
    const storage = makeStorage();
    // configurable:true so this overrides Node's native (unconfigured) accessor
    // and so re-running setup in a reused worker does not throw.
    Object.defineProperty(window, name, { configurable: true, get: () => storage });
  }
}
