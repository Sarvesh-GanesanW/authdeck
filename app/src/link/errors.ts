import type { ProtocolError } from '../protocol';

/**
 * Why a link step failed:
 * - `decrypt`: a message failed its integrity check (altered, replayed, reordered, or keyed by
 *   someone else, such as the wrong computer or a wrong PIN).
 * - `malformed`: a frame is cut short, too long, out of turn, or not the expected kind.
 * - `version`: the other side speaks a different link version.
 */
export type LinkFailure = 'decrypt' | 'malformed' | 'version';

/** A broken link. The connection must be closed; nothing more is read from it. */
export class LinkError extends Error {
  constructor(
    readonly reason: LinkFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LinkError';
  }
}

/** The other side understood the request and said no, with a reason for the user. */
export class LinkRefusal extends Error {
  constructor(readonly error: ProtocolError) {
    super(error.message);
    this.name = 'LinkRefusal';
  }
}
