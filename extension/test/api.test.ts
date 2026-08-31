import { CAPTURE_UPLOAD_FIELDS } from '@snapping-turtle/shared/api';
import { describe, expect, it, vi } from 'vitest';
import {
  buildUploadForm,
  classifyPingResponse,
  classifyUploadResponse,
  describeFailure,
  pingServer,
  uploadCapture,
} from '../src/lib/api.js';

const FAKE_TOKEN = 'st_FAKEFAKEFAKEFAKEFAKEFAKEFAK';
const ORIGIN = 'https://shots.example.com';

describe('classifyUploadResponse', () => {
  it('201 with two http(s) URLs is created', () => {
    const body = { pageUrl: `${ORIGIN}/s/abc`, imageUrl: `${ORIGIN}/s/abc/image.png` };
    expect(classifyUploadResponse(201, body)).toEqual({ kind: 'created', ...body });
  });

  it('401 is unauthorized regardless of body', () => {
    expect(classifyUploadResponse(401, { error: 'a valid API token is required' })).toEqual({
      kind: 'unauthorized',
    });
    expect(classifyUploadResponse(401, null)).toEqual({ kind: 'unauthorized' });
  });

  it('a 201 whose URLs are missing or not http(s) is treated as a failure, never opened', () => {
    expect(classifyUploadResponse(201, {}).kind).toBe('failed');
    expect(
      classifyUploadResponse(201, { pageUrl: 'javascript:alert(1)', imageUrl: 'x' }).kind,
    ).toBe('failed');
    expect(
      classifyUploadResponse(201, { pageUrl: `${ORIGIN}/s/abc`, imageUrl: 'file:///etc/passwd' })
        .kind,
    ).toBe('failed');
  });

  it('other statuses carry the server message, capped, with friendlier 413/429/5xx', () => {
    expect(classifyUploadResponse(400, { error: 'sourceUrl must be http or https' })).toEqual({
      kind: 'failed',
      message: 'Upload rejected (HTTP 400): sourceUrl must be http or https',
    });
    expect(describeFailure(413, { error: 'too big' })).toMatch(/too large \(HTTP 413\)/);
    expect(describeFailure(429, null)).toMatch(/slow down/);
    expect(describeFailure(500, { error: 'internal error' })).toMatch(/HTTP 500/);
    expect(describeFailure(422, null)).toBe('Upload rejected (HTTP 422).');
    expect(describeFailure(422, { error: 42 })).toBe('Upload rejected (HTTP 422).');
    expect(describeFailure(400, { error: 'x'.repeat(1000) })).toHaveLength(
      'Upload rejected (HTTP 400): '.length + 200,
    );
  });
});

describe('classifyPingResponse', () => {
  it('204 ok, 401 unauthorized, 404 hints at a wrong address, anything else fails', () => {
    expect(classifyPingResponse(204)).toEqual({ kind: 'ok' });
    expect(classifyPingResponse(401)).toEqual({ kind: 'unauthorized' });
    expect(classifyPingResponse(404)).toMatchObject({ kind: 'failed' });
    expect(classifyPingResponse(404)).toMatchObject({ message: expect.stringMatching(/ping/) });
    expect(classifyPingResponse(500)).toEqual({
      kind: 'failed',
      message: 'Unexpected response from the server (HTTP 500).',
    });
    expect(classifyPingResponse(200).kind).toBe('failed');
  });
});

describe('buildUploadForm', () => {
  it('uses exactly the M1 multipart field names with a file part named image', async () => {
    const image = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const form = buildUploadForm({ image, sourceUrl: 'https://example.com/p', title: 'T' });
    expect([...form.keys()].sort()).toEqual(
      [
        CAPTURE_UPLOAD_FIELDS.image,
        CAPTURE_UPLOAD_FIELDS.sourceUrl,
        CAPTURE_UPLOAD_FIELDS.title,
      ].sort(),
    );
    const file = form.get('image');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('capture.png');
    expect((file as File).type).toBe('image/png');
    expect(form.get('sourceUrl')).toBe('https://example.com/p');
    expect(form.get('title')).toBe('T');
  });
});

describe('uploadCapture / pingServer transport', () => {
  const image = new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' });
  const req = {
    origin: ORIGIN,
    token: FAKE_TOKEN,
    image,
    sourceUrl: 'https://example.com/',
    title: 'x',
  };

  it('posts multipart to /api/v1/captures with the bearer header and no cookies', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { pageUrl: `${ORIGIN}/s/abc`, imageUrl: `${ORIGIN}/s/abc/image.png` },
        { status: 201 },
      ),
    );
    const outcome = await uploadCapture(req, fetchImpl as unknown as typeof fetch);
    expect(outcome.kind).toBe('created');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/v1/captures`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('turns a network failure into a failed outcome that names the origin, not the token', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const outcome = await uploadCapture(req, fetchImpl as unknown as typeof fetch);
    expect(outcome).toMatchObject({ kind: 'failed', message: expect.stringContaining(ORIGIN) });
    expect(JSON.stringify(outcome)).not.toContain(FAKE_TOKEN);

    const ping = await pingServer(ORIGIN, FAKE_TOKEN, fetchImpl as unknown as typeof fetch);
    expect(ping).toMatchObject({ kind: 'failed', message: expect.stringContaining(ORIGIN) });
  });

  it('a non-JSON error body still yields a status-based message', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await uploadCapture(req, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: 'failed',
      message: 'The server had a problem (HTTP 502). Try again shortly.',
    });
  });

  it('pings GET /api/v1/ping with the bearer header and maps 204 / 401', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await pingServer(ORIGIN, FAKE_TOKEN, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: 'ok',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/v1/ping`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(init.credentials).toBe('omit');
    const denied = vi.fn(async () => new Response(null, { status: 401 }));
    expect(await pingServer(ORIGIN, FAKE_TOKEN, denied as unknown as typeof fetch)).toEqual({
      kind: 'unauthorized',
    });
  });
});
