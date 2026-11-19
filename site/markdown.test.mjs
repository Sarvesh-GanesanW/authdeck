// Run with: node --test site/markdown.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inline, markdownToHtml } from './markdown.mjs';

test('headings get ids from their text', () => {
  assert.equal(markdownToHtml('# AuthDeck privacy policy\n\n## Face ID, fingerprint and passcode'),
    '<h1 id="authdeck-privacy-policy">AuthDeck privacy policy</h1>\n<h2 id="face-id-fingerprint-and-passcode">Face ID, fingerprint and passcode</h2>');
});

test('a list right under a paragraph line splits into a paragraph and a list', () => {
  assert.equal(markdownToHtml('The app keeps these:\n- your keys\n- your settings'),
    '<p>The app keeps these:</p>\n<ul>\n<li>your keys</li>\n<li>your settings</li>\n</ul>');
});

test('code spans are kept literally and escaped', () => {
  assert.equal(inline('files (`.authdeck/<set>.env`) & more'), 'files (<code>.authdeck/&lt;set&gt;.env</code>) &amp; more');
});

test('links become anchors, escaped once', () => {
  assert.equal(inline('see [the policy](https://example.com/a?b=1&c=2) or [mail](mailto:hello@authdeck.in)'),
    'see <a href="https://example.com/a?b=1&amp;c=2">the policy</a> or <a href="mailto:hello@authdeck.in">mail</a>');
});

test('links to other schemes are refused', () => {
  assert.throws(() => inline('[x](javascript:alert(1))'), /must start with https/);
});

test('Markdown outside the subset is refused', () => {
  for (const line of ['### Deep', '* star', '1. one', '> quote', '| a |', '```', '<!-- note -->']) {
    assert.throws(() => markdownToHtml(line), /doesn't support/, line);
  }
  assert.throws(() => inline('an `open code span'), /Unmatched backtick/);
});

test('the privacy policy converts', () => {
  const html = markdownToHtml(readFileSync(new URL('../app/store/privacy.md', import.meta.url), 'utf8'));
  assert.match(html, /<h2 id="this-website">This website<\/h2>/);
  assert.match(html, /<a href="mailto:hello@authdeck.in">hello@authdeck.in<\/a>/);
});
