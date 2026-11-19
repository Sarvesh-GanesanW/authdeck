/**
 * The encrypted channel after a handshake. One protocol message (a JSON request, response or
 * event) becomes one or more transport frames, because a Noise message holds at most 64 KiB.
 * Each frame is a Noise transport message whose first plaintext byte says whether more follow,
 * so the split is authenticated too.
 */
import { concatBytes, utf8Decode, utf8Encode } from '../vault/bytes';
import { LinkError } from './errors';
import { FRAME, expectFrame, frameHeader } from './frames';
import { MAX_NOISE_MESSAGE, TAG_LEN, type TransportKeys } from './noise';

const MORE_FOLLOWS = 0;
const LAST_CHUNK = 1;
/** Plaintext bytes per frame after the flag byte. */
const CHUNK_BYTES = MAX_NOISE_MESSAGE - TAG_LEN - 1;
const TRANSPORT_HEADER = frameHeader(FRAME.transport);

export class SecureChannel {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** seal() fills every chunk but the last, so an honest message never needs more than this. */
  private readonly maxChunks: number;

  constructor(
    private readonly keys: TransportKeys,
    /** The longest message the other side may send, after joining its chunks. */
    private readonly maxMessageBytes: number,
  ) {
    this.maxChunks = Math.ceil(maxMessageBytes / CHUNK_BYTES) + 1;
  }

  /** The other side's static public key, proven by the handshake. */
  get remoteStatic(): Uint8Array {
    return this.keys.remoteStatic;
  }

  /** Encrypts one message into frames. Send them in order, all of them. */
  seal(message: string): Uint8Array[] {
    const plaintext = utf8Encode(message);
    const frames: Uint8Array[] = [];
    let offset = 0;
    do {
      const chunk = plaintext.subarray(offset, offset + CHUNK_BYTES);
      offset += chunk.length;
      const flag = offset < plaintext.length ? MORE_FOLLOWS : LAST_CHUNK;
      const ciphertext = this.keys.send.encryptWithAd(TRANSPORT_HEADER, concatBytes(Uint8Array.of(flag), chunk));
      frames.push(concatBytes(TRANSPORT_HEADER, ciphertext));
    } while (offset < plaintext.length);
    return frames;
  }

  /**
   * Decrypts one frame. Returns the message when this frame completes it, or null while more
   * chunks are due. Throws `LinkError` for anything altered, replayed, reordered or oversized,
   * and for an empty chunk that says more follow or more chunks than any message needs (both would
   * let a peer grow memory without ever finishing a message); the connection must then be closed.
   */
  open(frame: Uint8Array): string | null {
    const body = expectFrame(frame, FRAME.transport);
    if (body.length > MAX_NOISE_MESSAGE) throw new LinkError('malformed', 'A link frame is longer than a Noise message may be.');
    const plaintext = this.keys.receive.decryptWithAd(TRANSPORT_HEADER, body);
    const flag = plaintext[0];
    if (flag !== MORE_FOLLOWS && flag !== LAST_CHUNK) throw new LinkError('malformed', 'A link frame has an unknown chunk flag.');
    const chunk = plaintext.subarray(1);
    if (flag === MORE_FOLLOWS && chunk.length === 0) throw new LinkError('malformed', 'A link frame is an empty chunk of a longer message.');
    if (this.pending.length + 1 > this.maxChunks) throw new LinkError('malformed', `A message is split into more than ${this.maxChunks} chunks.`);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes > this.maxMessageBytes) throw new LinkError('malformed', `A message is longer than ${this.maxMessageBytes} bytes.`);
    this.pending.push(chunk);
    if (flag === MORE_FOLLOWS) return null;
    const message = concatBytes(...this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      return utf8Decode(message, 'A link message');
    } catch {
      // Authenticated, so the peer sent it: it is the peer's fault, like any other bad frame.
      throw new LinkError('malformed', 'A link message is not valid UTF-8.');
    }
  }
}
