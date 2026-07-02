import { expect, test } from 'vitest';
import { escapeXml } from '../../src/xml/escape.js';

test('escapes the five XML metacharacters', () => {
  expect(escapeXml('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
});
test('leaves ordinary text unchanged', () => {
  expect(escapeXml('INV-2026-001 Piegāde')).toBe('INV-2026-001 Piegāde');
});
test('coerces non-strings safely', () => {
  expect(escapeXml(String(42))).toBe('42');
});
