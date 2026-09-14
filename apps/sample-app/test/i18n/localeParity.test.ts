/**
 * Locale key parity (spec §18.4): every key in an `en` namespace dictionary
 * must have the exact same key in the matching `zh-TW` dictionary, and vice
 * versa. Catches drift between the two locale trees directly, without needing
 * a React/i18next harness.
 *
 * Reads the JSON files from disk rather than importing them (as ES modules,
 * or via `src/i18n/index.ts`) — plain `node --test` (unlike Vite) requires a
 * `with { type: 'json' }` import attribute per JSON file, which
 * `--experimental-strip-types` does not reliably carry through, and
 * `src/i18n/index.ts` itself calls `i18n.init()` and touches
 * `document.documentElement` at module scope, which has no `document` outside
 * a browser. `readFileSync` + `JSON.parse`, and deriving the namespace list
 * from the `en/` directory listing, sidesteps both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const localesDir = fileURLToPath(new URL('../../src/locales/', import.meta.url));

const NAMESPACES = readdirSync(`${localesDir}en`)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

function readDict(locale: string, ns: string): object {
  return JSON.parse(readFileSync(`${localesDir}${locale}/${ns}.json`, 'utf8'));
}

/** Every leaf key path in a (possibly nested) dictionary, dotted (e.g. `sceneHierarchy.addMenu.camera`). */
function keyPaths(dict: object, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [k, v] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) paths.push(...keyPaths(v, path));
    else paths.push(path);
  }
  return paths;
}

for (const ns of NAMESPACES) {
  test(`en/${ns}.json and zh-TW/${ns}.json carry exactly the same keys (spec §18.4)`, () => {
    const enKeys = new Set(keyPaths(readDict('en', ns)));
    const zhKeys = new Set(keyPaths(readDict('zh-TW', ns)));

    const missingInZhTW = [...enKeys].filter((k) => !zhKeys.has(k));
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));

    assert.deepEqual(missingInZhTW, [], `zh-TW/${ns}.json is missing keys present in en: ${missingInZhTW.join(', ')}`);
    assert.deepEqual(missingInEn, [], `en/${ns}.json is missing keys present in zh-TW: ${missingInEn.join(', ')}`);
  });
}
