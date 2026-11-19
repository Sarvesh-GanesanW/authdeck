/**
 * The env sets contracts on the phone (slice 0): an agent that announces env sets still passes the
 * app's checks, and a refused file is worded for the device the person holds.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { envFileProblemWords } from '../src/envcore/types';
import { isAgentInfo } from '../src/net/messages';
import { ENV_FEATURE, PROTOCOL_VERSION, type AgentInfo } from '../src/protocol';

describe('env sets contracts on the phone', () => {
  it('accepts an agent that lists env sets among its features', () => {
    const agent: AgentInfo = { agentId: 'a1', name: 'MacBook Pro', platform: 'macos', version: '0.4.0', protocol: PROTOCOL_VERSION, features: [ENV_FEATURE] };
    assert.equal(isAgentInfo(agent), true);
  });

  it('tells the phone to fix a tampered line here', () => {
    const words = envFileProblemWords(
      { kind: 'unsigned-line', line: 14, name: 'DATABASE_URL' },
      { file: '.authdeck/acme-api.env', set: 'acme-api', commit: '77b0e1d', where: 'phone' },
    );
    assert.equal(words.title, "A line isn't signed by a member");
    assert.equal(words.hint, 'Revert that commit, or set DATABASE_URL again here.');
  });
});
