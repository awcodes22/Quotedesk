// @ts-check
import { ICONS } from "./icons.js";

/** @typedef {import("./icons.js").IconName} IconName */
/** @typedef {Record<string, string | number | boolean | undefined>} Attributes */
/** @typedef {Node | string | null | undefined} Child */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * @param {Element} element
 * @param {string} name
 * @param {string | number | boolean | undefined} value
 */
function setAttribute(element, name, value) {
  if (value === undefined || value === false) {
    return;
  }

  if (value === true) {
    element.setAttribute(name, "");
    return;
  }

  element.setAttribute(name, String(value));
}

/**
 * Strings become text nodes, so engine and transcript text can never become markup.
 * @param {Element} parent
 * @param {Child[]} children
 */
function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }

    if (typeof child === "string") {
      parent.appendChild(document.createTextNode(child));
    } else {
      parent.appendChild(child);
    }
  }
}

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {Attributes} [attributes]
 * @param {Child[]} [children]
 * @returns {HTMLElementTagNameMap[Tag]}
 */
export function el(tag, attributes, children) {
  const element = document.createElement(tag);

  if (attributes !== undefined) {
    for (const [name, value] of Object.entries(attributes)) {
      setAttribute(element, name, value);
    }
  }

  if (children !== undefined) {
    appendChildren(element, children);
  }

  return element;
}

/**
 * Skips the write when nothing changed, since renders run every frame.
 * @param {Node} node
 * @param {string} text
 */
export function setText(node, text) {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

/** @param {Node} node */
export function clear(node) {
  while (node.firstChild !== null) {
    node.removeChild(node.firstChild);
  }
}

/**
 * Icon shapes are the only HTML strings the page trusts, and they come from icons.js.
 * @param {IconName} name
 * @param {number} size
 * @param {string} [color]
 * @returns {SVGSVGElement}
 */
export function icon(name, size, color) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");

  // Setting color, not stroke, also tints shapes filled with currentColor, like the tag's dot.
  if (color !== undefined) {
    svg.setAttribute("color", color);
  }

  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}
