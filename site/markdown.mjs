/**
 * Turns the small Markdown subset that app/store/privacy.md uses into HTML, so the policy has one
 * source. Supported: `#` and `##` headings, paragraphs, `- ` lists, `inline code` and
 * [links](url). Anything else throws, so a new construct in the policy can't slip onto the site
 * as raw text.
 */

const HEADING = /^(#{1,2}) (.+)$/;
const LIST_ITEM = /^- (.+)$/;
/** Line starts the subset doesn't handle: deeper headings, other lists, quotes, tables, fences, HTML. */
const UNSUPPORTED_LINE = /^(#{3,}|\* |\+ |\d+[.)] |> |\||```|<)/;
const CODE_SPAN = /`([^`]+)`/g;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const ALLOWED_LINK = /^(https:\/\/|mailto:)/;

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A heading's text as an id: lower case, words joined by hyphens. */
export function slug(text) {
  return text.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function inlineLinks(text) {
  const withLinks = text.replace(LINK, (_, label, url) => {
    if (!ALLOWED_LINK.test(url)) throw new Error(`Link "${url}" must start with https:// or mailto:.`);
    return `\u0000${url}\u0001${label}\u0002`;
  });
  if (withLinks.includes('](')) throw new Error(`Unfinished link in: ${text}`);
  return escapeHtml(withLinks).replace(/\u0000([^\u0001]*)\u0001([^\u0002]*)\u0002/g, '<a href="$1">$2</a>');
}

/** Inline Markdown to HTML: code spans are kept literally, links become anchors, the rest is escaped. */
export function inline(text) {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    html += inlineLinks(text.slice(last, match.index));
    html += `<code>${escapeHtml(match[1])}</code>`;
    last = match.index + match[0].length;
  }
  html += inlineLinks(text.slice(last));
  if (html.includes('`')) throw new Error(`Unmatched backtick in: ${text}`);
  return html;
}

/** Splits one block of consecutive lines into paragraph and list runs. */
function blockToHtml(lines) {
  const parts = [];
  let paragraph = [];
  let items = [];
  const flushParagraph = () => {
    if (paragraph.length) parts.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (items.length) parts.push(`<ul>\n${items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</ul>`);
    items = [];
  };
  for (const line of lines) {
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      items.push(item[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return parts;
}

/** The whole document as HTML. Headings get ids from their text, so sections can be linked to. */
export function markdownToHtml(markdown) {
  const parts = [];
  let block = [];
  const flushBlock = () => {
    parts.push(...blockToHtml(block));
    block = [];
  };
  for (const [index, raw] of markdown.split('\n').entries()) {
    const line = raw.trimEnd();
    if (UNSUPPORTED_LINE.test(line)) throw new Error(`Line ${index + 1} uses Markdown the site build doesn't support: ${line}`);
    const heading = HEADING.exec(line);
    if (heading) {
      flushBlock();
      const level = heading[1].length;
      parts.push(`<h${level} id="${slug(heading[2])}">${inline(heading[2])}</h${level}>`);
    } else if (line === '') {
      flushBlock();
    } else {
      block.push(line);
    }
  }
  flushBlock();
  return parts.join('\n');
}
