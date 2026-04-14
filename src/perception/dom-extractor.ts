/**
 * DOM extraction script injected into pages via CDP Runtime.evaluate.
 * Synthesized from page-agent's dom_tree extraction — traverses the live DOM,
 * identifies interactive elements, and returns a flattened tree structure.
 */

/**
 * This string is evaluated inside the browser context.
 * It returns a JSON-serializable FlatDomTree.
 */
export const DOM_EXTRACTION_SCRIPT = `
(() => {
  const INTERACTIVE_TAGS = new Set([
    'a', 'button', 'input', 'select', 'textarea', 'details', 'summary',
    'label', 'option', 'fieldset', 'legend',
  ]);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'combobox', 'listbox', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox',
    'slider', 'spinbutton', 'switch', 'tab', 'checkbox', 'treeitem',
  ]);

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'svg', 'link', 'meta', 'head',
  ]);

  let highlightIndex = 0;
  const map = {};
  let rootId = null;

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInViewport(el) {
    if (!(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  }

  function isInteractive(el) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    // Check cursor style
    const style = window.getComputedStyle(el);
    if (style.cursor === 'pointer') return true;
    return false;
  }

  function getXPath(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      const tag = current.tagName.toLowerCase();
      parts.unshift(tag + '[' + index + ']');
      current = current.parentElement;
    }
    return '/html/body/' + parts.join('/');
  }

  function getAttributes(el) {
    const attrs = {};
    for (const attr of el.attributes || []) {
      if (['class', 'style', 'data-reactid'].includes(attr.name)) continue;
      if (attr.name.startsWith('on')) continue;
      attrs[attr.name] = attr.value.slice(0, 200);
    }
    return attrs;
  }

  function getTextContent(el) {
    // Direct text content only (not children)
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) { // TEXT_NODE
        text += child.textContent.trim() + ' ';
      }
    }
    return text.trim().slice(0, 500);
  }

  function isScrollable(el) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const canScrollY = (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    const canScrollX = (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth;
    return canScrollY || canScrollX;
  }

  function traverse(node, depth) {
    if (depth > 30) return null;
    if (!(node instanceof HTMLElement)) return null;

    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;
    if (!isVisible(node)) return null;

    const nodeId = 'n_' + Math.random().toString(36).slice(2, 8);
    const interactive = isInteractive(node);
    const inViewport = isInViewport(node);
    const rect = node.getBoundingClientRect();

    const attrs = getAttributes(node);
    if (isScrollable(node)) {
      attrs['data-scrollable'] = JSON.stringify({
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollLeft: node.scrollLeft,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      });
    }

    const domNode = {
      nodeId,
      tagName: tag,
      attributes: attrs,
      children: [],
      textContent: getTextContent(node),
      isInteractive: interactive,
      isVisible: true,
      isInViewport: inViewport,
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      xpath: interactive ? getXPath(node) : '',
    };

    if (interactive) {
      domNode.highlightIndex = highlightIndex++;
      // Mark element in the DOM for later reference
      node.setAttribute('data-phantom-idx', String(domNode.highlightIndex));
    }

    // Recurse into children
    for (const child of node.children) {
      const childId = traverse(child, depth + 1);
      if (childId) domNode.children.push(childId);
    }

    map[nodeId] = domNode;
    return nodeId;
  }

  // Clean previous marks
  document.querySelectorAll('[data-phantom-idx]').forEach(el => el.removeAttribute('data-phantom-idx'));
  highlightIndex = 0;

  rootId = traverse(document.body, 0);

  return JSON.stringify({
    rootId,
    map,
    pageInfo: {
      url: location.href,
      title: document.title,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    },
  });
})()
`;
