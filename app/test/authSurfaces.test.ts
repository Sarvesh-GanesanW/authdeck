/** AuthHost shows one surface at a time: a sheet opened from the vault screen closes back to it. */
import './native';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useAuthUi } from '../src/auth/ui';

beforeEach(() => useAuthUi.setState({ surface: null, returnTo: null }));

test('closing Add account opened from the vault returns to the vault', () => {
  const ui = useAuthUi.getState();
  ui.open('vault');
  ui.open('add-account');
  useAuthUi.getState().close();
  assert.equal(useAuthUi.getState().surface, 'vault');
  useAuthUi.getState().close();
  assert.equal(useAuthUi.getState().surface, null);
});

test('a sheet opened from the deck closes to the deck', () => {
  useAuthUi.getState().open('add-account');
  useAuthUi.getState().close();
  assert.equal(useAuthUi.getState().surface, null);
});

test('a sheet that leads to another from the vault still closes back to the vault', () => {
  const ui = useAuthUi.getState();
  ui.open('vault');
  ui.open('restore');
  useAuthUi.getState().open('recovery-setup');
  useAuthUi.getState().close();
  assert.equal(useAuthUi.getState().surface, 'vault');
});
