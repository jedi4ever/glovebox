// Minimal YAML subset parser for cc-msb config files.
// Handles: inline scalars, inline lists [a,b,c], block lists (- item),
// 3-level nesting (defaults.main, defaults.agents, agents.<name>),
// comment stripping, quote stripping. No external dependencies.
//
// Recognised top-level sections: presets, main, agents, defaults (alias: default)
// Returns: { presets: string[], sections: { [path]: { [key]: string } } }
// Path examples: 'main', 'defaults', 'defaults.main', 'defaults.agents', 'agents.<name>'
// All list values are stored as comma-separated strings.

import { existsSync, readFileSync } from 'node:fs';

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) ||
       (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map(p => unquote(p.trim())).filter(Boolean).join(',');
  }
  return unquote(s);
}

function tokenize(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const tokens = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    // Strip inline comment (consistent with original AWK behaviour)
    const stripped = trimmed.replace(/\s*#.*$/, '').trimEnd();
    if (stripped) tokens.push({ indent, raw: stripped });
  }
  return tokens;
}

// Build a lightweight tree from tokens using an indent stack.
// Each node: { key?, value, indent, isListItem, children[] }
function buildTree(tokens) {
  const root = { indent: -1, value: '', children: [] };
  const stack = [root];

  for (const t of tokens) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= t.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];

    if (t.raw.startsWith('- ')) {
      parent.children.push({ isListItem: true, value: unquote(t.raw.slice(2).trim()), indent: t.indent, children: [] });
      continue;
    }

    const colon = t.raw.indexOf(':');
    if (colon === -1) continue;
    const key = t.raw.slice(0, colon).trim();
    const rest = t.raw.slice(colon + 1).trim();
    const node = { key, value: rest ? parseValue(rest) : '', indent: t.indent, children: [] };
    parent.children.push(node);
    stack.push(node);
  }

  return root;
}

// Flatten a mapping node's direct children into sections[path].
function extractFlat(sections, path, node) {
  for (const child of node.children) {
    if (child.isListItem) continue;
    const items = child.children.filter(c => c.isListItem).map(c => c.value);
    const val = child.value || (items.length ? items.join(',') : '');
    if (val) {
      if (!sections[path]) sections[path] = {};
      sections[path][child.key] = val;
    }
  }
}

export function parseFile(filePath) {
  if (!existsSync(filePath)) return { presets: [], sections: {} };

  const tokens = tokenize(filePath);
  const root = buildTree(tokens);
  const sections = {};
  const presets = [];

  for (const topNode of root.children) {
    if (topNode.isListItem) continue;
    const normKey = topNode.key === 'default' ? 'defaults' : topNode.key;

    if (normKey === 'presets') {
      if (topNode.value) {
        topNode.value.split(',').forEach(p => { const t = p.trim(); if (t) presets.push(t); });
      } else {
        topNode.children.filter(c => c.isListItem).forEach(c => presets.push(c.value));
      }
      continue;
    }

    if (normKey === 'main') {
      extractFlat(sections, 'main', topNode);
      continue;
    }

    if (normKey === 'agents') {
      for (const agentNode of topNode.children) {
        if (!agentNode.isListItem && !agentNode.value) {
          extractFlat(sections, `agents.${agentNode.key}`, agentNode);
        }
      }
      continue;
    }

    if (normKey === 'defaults') {
      for (const child of topNode.children) {
        if (child.isListItem) continue;
        if (!child.value && (child.key === 'main' || child.key === 'agents')) {
          extractFlat(sections, `defaults.${child.key}`, child);
        } else {
          const items = child.children.filter(c => c.isListItem).map(c => c.value);
          const val = child.value || (items.length ? items.join(',') : '');
          if (val) {
            if (!sections['defaults']) sections['defaults'] = {};
            sections['defaults'][child.key] = val;
          }
        }
      }
      continue;
    }
  }

  return { presets, sections };
}
