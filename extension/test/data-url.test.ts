import { describe, expect, it } from 'vitest';
import { dataUrlToBlob } from '../src/lib/data-url.js';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('dataUrlToBlob', () => {
  it('decodes a base64 PNG data URL into a typed Blob with the original bytes', async () => {
    const bytes = Uint8Array.from([...PNG_HEADER, 0, 1, 2, 254, 255]);
    const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const blob = dataUrlToBlob(dataUrl);
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it('handles the percent-encoded (non-base64) form and an empty payload', async () => {
    const blob = dataUrlToBlob('data:text/plain,hello%20world');
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hello world');
    expect(dataUrlToBlob('data:image/png;base64,').size).toBe(0);
  });

  it('rejects anything that is not a data URL', () => {
    expect(() => dataUrlToBlob('https://example.com/x.png')).toThrow(/data URL/);
    expect(() => dataUrlToBlob('')).toThrow(/data URL/);
  });
});
