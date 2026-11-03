// Pure namespace adaptation. Codex remains responsible for tool execution and approval.
import { createHash } from 'node:crypto';

const ERRORS = Object.freeze({
  native_tools_invalid: 'The native tool data is invalid.',
  native_tools_unsupported: 'The native tool shape is unsupported.',
  native_tools_conflict: 'The native tool names conflict.',
  native_tool_unknown: 'The selected native tool is not declared.',
});

export class NativeToolError extends Error {
  constructor(code) {
    const safeCode = typeof code === 'string' && Object.hasOwn(ERRORS, code)
      ? code : 'native_tools_invalid';
    super(ERRORS[safeCode]);
    this.name = 'NativeToolError';
    this.code = safeCode;
  }
}

const fail = code => { throw new NativeToolError(code); };
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Local metadata bound, separate from the upstream function-name constraint.
const validName = value => typeof value === 'string' && value.length <= 512
  && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 512;
const UPSTREAM_FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

function copy(value) {
  try { return structuredClone(value); }
  catch { fail('native_tools_invalid'); }
}

function namespaceOf(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!validName(value)) fail('native_tools_invalid');
  return value;
}

function aliasFor(namespace, name) {
  return 'dsns_' + createHash('sha256').update(JSON.stringify([namespace, name]))
    .digest('hex').slice(0, 32);
}

function checkFunction(tool) {
  if (!plain(tool) || !validName(tool.name)
      || tool.description !== undefined && typeof tool.description !== 'string') {
    fail('native_tools_invalid');
  }
}

/**
 * Flatten function namespaces for an upstream provider, then restore Codex's
 * exact (namespace, name) identity. History never expands the current allowlist.
 */
export function adaptNativeTools(body) {
  if (!plain(body)) fail('native_tools_invalid');
  const request = copy(body);
  const tools = Object.hasOwn(request, 'tools') ? request.tools : [];
  if (!Array.isArray(tools)) fail('native_tools_invalid');
  const topNames = new Set();
  const topFunctions = new Set();
  const namespaceNames = new Set();
  const aliases = new Map();
  const currentTuples = new Map();

  // Collect top-level names first, so collisions are independent of tool order.
  for (const tool of tools) {
    if (!plain(tool)) fail('native_tools_invalid');
    if (tool.type === 'function' || tool.type === 'custom') {
      checkFunction(tool);
      if (tool.type === 'function' && !UPSTREAM_FUNCTION_NAME.test(tool.name)) {
        fail('native_tools_invalid');
      }
      if (tool.type === 'custom' && tool.name !== 'apply_patch') fail('native_tools_unsupported');
      if (topNames.has(tool.name)) fail('native_tools_conflict');
      topNames.add(tool.name);
      if (tool.type === 'function') topFunctions.add(tool.name);
    } else if (tool.type === 'namespace') {
      if (!validName(tool.name) || tool.description !== undefined && typeof tool.description !== 'string'
          || !Array.isArray(tool.tools)) fail('native_tools_invalid');
      if (namespaceNames.has(tool.name)) fail('native_tools_conflict');
      namespaceNames.add(tool.name);
    } else fail('native_tools_unsupported');
  }

  const flattened = [];
  for (const tool of tools) {
    if (tool.type !== 'namespace') { flattened.push(tool); continue; }
    for (const child of tool.tools) {
      if (!plain(child)) fail('native_tools_invalid');
      if (child.type !== 'function') fail('native_tools_unsupported');
      checkFunction(child);
      const tuple = JSON.stringify([tool.name, child.name]);
      const alias = aliasFor(tool.name, child.name);
      // Codex treats top-level tools as members of the functions namespace.
      if (currentTuples.has(tuple) || aliases.has(alias) || topNames.has(alias)
          || tool.name === 'functions' && topNames.has(child.name)) {
        fail('native_tools_conflict');
      }
      currentTuples.set(tuple, alias);
      aliases.set(alias, { namespace: tool.name, name: child.name });
      flattened.push({ ...child, name: alias,
        description: `Namespace ${tool.name}` + (tool.description ? `: ${tool.description}` : '.')
          + (child.description ? `\n\n${child.description}` : '') });
    }
  }
  if (Object.hasOwn(request, 'tools')) request.tools = flattened;

  const translatedAliases = new Map(aliases);
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (item?.type !== 'function_call') continue;
      if (!validName(item.name)) fail('native_tools_invalid');
      const namespace = namespaceOf(item.namespace);
      if (namespace !== null) {
        const alias = aliasFor(namespace, item.name);
        const previous = translatedAliases.get(alias);
        if (topNames.has(alias) || previous
            && (previous.namespace !== namespace || previous.name !== item.name)) {
          fail('native_tools_conflict');
        }
        translatedAliases.set(alias, { namespace, name: item.name });
        item.name = alias;
        delete item.namespace;
      }
    }
  }

  if (Object.hasOwn(request, 'tool_choice')) {
    const choice = request.tool_choice;
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) fail('native_tools_unsupported');
    } else {
      if (!plain(choice) || choice.type !== 'function'
          || Object.keys(choice).some(key => !['type', 'name', 'namespace'].includes(key))) {
        fail('native_tools_unsupported');
      }
      if (!validName(choice.name)) fail('native_tools_invalid');
      const namespace = namespaceOf(choice.namespace);
      if (namespace !== null) {
        const alias = currentTuples.get(JSON.stringify([namespace, choice.name]));
        if (!alias) fail('native_tool_unknown');
        choice.name = alias;
        delete choice.namespace;
      } else if (!topFunctions.has(choice.name)) fail('native_tool_unknown');
    }
  }

  function restoreResponse(response) {
    if (!plain(response) || !Array.isArray(response.output)) fail('native_tools_invalid');
    const restored = copy(response);
    for (const item of restored.output) {
      if (item?.type !== 'function_call') continue;
      if (!validName(item.name)) fail('native_tools_invalid');
      if (namespaceOf(item.namespace) !== null) fail('native_tool_unknown');
      const original = aliases.get(item.name);
      if (original) {
        item.name = original.name;
        item.namespace = original.namespace;
      } else if (!topFunctions.has(item.name)) fail('native_tool_unknown');
    }
    return restored;
  }

  return { request, restoreResponse };
}
