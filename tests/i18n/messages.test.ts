import { expect, test } from 'vitest';
import { t } from '../../src/i18n/messages.js';

test('resolves a key per language, falls back to en', () => {
  expect(t('lv', 'approve')).toBe('Apstiprināt');
  expect(t('ru', 'approve')).toBe('Подтвердить');
  expect(t('en', 'approve')).toBe('Approve');
  expect(t('lv', 'nonexistent_key')).toBe('nonexistent_key'); // missing key returns the key
});
