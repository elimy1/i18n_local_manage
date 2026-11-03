"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADAPTER_IDS = exports.ADAPTERS = void 0;
exports.getAdapter = getAdapter;
exports.adapterFromDeps = adapterFromDeps;
exports.collectDeps = collectDeps;
exports.resolveAdapter = resolveAdapter;
exports.catalogPath = catalogPath;
/**
 * Framework adapters.
 *
 * The engine is deliberately framework-blind: it collects candidates, scores them and
 * rewrites them through one gate stack. What changes between projects is small but
 * load-bearing — where `t` comes from, where catalog files live, which package means
 * "this is a React app". That is all an adapter is.
 *
 * Keeping this in its own package (rather than in core) is what lets a project ship a
 * custom adapter without forking the engine, and lets the CLI and the extension agree
 * on one answer for "which adapter is this".
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const REACT_I18NEXT = {
    id: 'react-i18next',
    label: 'React + react-i18next',
    packages: ['react-i18next', 'i18next'],
    aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
    catalog: { dir: 'public/locales', locale: 'en', extension: 'json' },
};
const NEXT_INTL = {
    id: 'next-intl',
    label: 'Next.js + next-intl',
    packages: ['next-intl'],
    aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
    catalog: { dir: 'messages', locale: 'en', extension: 'json' },
};
const VUE_I18N = {
    id: 'vue-i18n',
    label: 'Vue 3 + vue-i18n',
    packages: ['vue-i18n'],
    aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
    catalog: { dir: 'src/locales', locale: 'zh-CN', extension: 'json' },
};
const GENERIC = {
    id: 'generic',
    label: 'Generic (framework-neutral)',
    packages: [],
    aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
    catalog: { dir: 'locales', locale: 'en', extension: 'json' },
};
exports.ADAPTERS = [NEXT_INTL, REACT_I18NEXT, VUE_I18N, GENERIC];
exports.ADAPTER_IDS = exports.ADAPTERS.map((a) => a.id);
function getAdapter(id) {
    const found = exports.ADAPTERS.find((a) => a.id === id);
    if (!found)
        throw new Error(`unknown adapter "${id}" (expected one of: ${exports.ADAPTER_IDS.join(', ')})`);
    return found;
}
/** Pick an adapter from a dependency map. Pure, so it is cheap to test. */
function adapterFromDeps(deps) {
    for (const adapter of exports.ADAPTERS) {
        if (adapter.packages.some((p) => p in deps))
            return adapter;
    }
    return GENERIC;
}
/**
 * Read dependencies from the root manifest and from the manifests one workspace level
 * down. A monorepo almost never declares its i18n library at the root — the app package
 * does — and reporting "generic" for a Vue monorepo is the kind of wrong answer that
 * makes people distrust detection.
 */
function collectDeps(root) {
    const deps = {};
    const read = (dir) => {
        try {
            const json = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(dir, 'package.json'), 'utf8'));
            Object.assign(deps, json.devDependencies ?? {}, json.dependencies ?? {});
        }
        catch {
            /* no manifest here — that is a valid state, not an error */
        }
    };
    read(root);
    for (const group of ['apps', 'packages', 'playground', 'examples']) {
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(node_path_1.default.join(root, group), { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory())
                read(node_path_1.default.join(root, group, entry.name));
        }
    }
    return deps;
}
/**
 * Resolve the adapter for a project root.
 *
 * `auto` reads package.json. An explicit id always wins: guessing wrong is cheap to
 * correct, but silently ignoring a user's choice is not.
 */
function resolveAdapter(root, requested) {
    if (requested && requested !== 'auto')
        return getAdapter(requested);
    return adapterFromDeps(collectDeps(root));
}
/** Default catalog path for an adapter: `<dir>/<locale>.<ext>` under the project root. */
function catalogPath(adapter, root) {
    return node_path_1.default.join(root, adapter.catalog.dir, `${adapter.catalog.locale}.${adapter.catalog.extension}`);
}
