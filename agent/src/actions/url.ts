import { badRequest } from '../errors';

/**
 * Accepts web links and app links (vscode://, slack:// …). Rejects file: links (use an `open`
 * action) and single-letter "schemes", which are Windows drive letters.
 */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest(`"${input}" is not a link. Links start with a scheme such as https://.`);
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'file') throw badRequest('File links are not allowed here; use an Open file or folder key instead.');
  if (scheme.length < 2) throw badRequest(`"${input}" looks like a file path, not a link.`);
  return url.href;
}
