/**
 * Serialize a FlatDomTree into simplified text for LLM consumption.
 * Synthesized from page-agent's flatTreeToString — produces indexed,
 * indented representation that the agent can reason about.
 */
import type { FlatDomTree, DomNode } from '../types.js';

export interface PageInfo {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
}

export interface SerializedPage {
  header: string;
  content: string;
  footer: string;
  interactiveCount: number;
  selectorMap: Map<number, DomNode>;
}

/**
 * Convert a flat DOM tree into LLM-friendly text.
 * Interactive elements get [index] prefixes for tool reference.
 */
export function serializeDomTree(
  tree: FlatDomTree,
  pageInfo: PageInfo,
  previousIndexes?: Set<number>,
): SerializedPage {
  const selectorMap = new Map<number, DomNode>();
  const lines: string[] = [];
  let interactiveCount = 0;

  function walk(nodeId: string, depth: number) {
    const node = tree.map[nodeId];
    if (!node) return;

    const indent = '\t'.repeat(depth);
    const tag = node.tagName;

    // Build attribute string for meaningful attributes
    const attrParts: string[] = [];
    for (const [key, val] of Object.entries(node.attributes)) {
      if (['id', 'name', 'type', 'role', 'aria-label', 'placeholder', 'href', 'value', 'alt', 'title', 'data-scrollable'].includes(key)) {
        attrParts.push(`${key}='${val.slice(0, 100)}'`);
      }
    }
    const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : '';

    // Build text content
    const text = node.textContent.slice(0, 200);

    if (node.isInteractive && node.highlightIndex !== undefined) {
      const idx = node.highlightIndex;
      selectorMap.set(idx, node);
      interactiveCount++;

      const isNew = previousIndexes && !previousIndexes.has(idx);
      const prefix = isNew ? `*[${idx}]` : `[${idx}]`;
      lines.push(`${indent}${prefix}<${tag}${attrStr}>${text}</${tag}>`);
    } else if (text || node.children.length > 0) {
      // Non-interactive but has content
      if (text && !['div', 'span', 'section', 'main', 'article', 'nav', 'header', 'footer'].includes(tag)) {
        lines.push(`${indent}<${tag}${attrStr}>${text}</${tag}>`);
      } else if (text && text.length > 3) {
        // Show meaningful text nodes
        lines.push(`${indent}${text}`);
      }
    }

    // Recurse children
    for (const childId of node.children) {
      walk(childId, depth + 1);
    }
  }

  if (tree.rootId) {
    walk(tree.rootId, 0);
  }

  // Build header with page info
  const pagesAbove = Math.floor(pageInfo.scrollY / pageInfo.viewportHeight);
  const totalPages = Math.ceil(pageInfo.scrollHeight / pageInfo.viewportHeight);
  const pixelsBelow = Math.max(0, pageInfo.scrollHeight - pageInfo.scrollY - pageInfo.viewportHeight);
  const pixelsAbove = pageInfo.scrollY;

  const header = [
    `Current URL: ${pageInfo.url}`,
    `Page title: ${pageInfo.title}`,
    `Viewport: ${pageInfo.viewportWidth}×${pageInfo.viewportHeight}`,
    `Interactive elements: ${interactiveCount}`,
    pixelsAbove > 0 ? `... ${pixelsAbove}px above (page ${pagesAbove + 1}/${totalPages}) ...` : '',
  ].filter(Boolean).join('\n');

  const footer = pixelsBelow > 0
    ? `... ${pixelsBelow}px below — scroll down for more content ...`
    : '--- End of page ---';

  return {
    header,
    content: lines.join('\n'),
    footer,
    interactiveCount,
    selectorMap,
  };
}
