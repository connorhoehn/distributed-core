import { HttpForwardingTransport, MisdirectedError, TimeoutError } from '../../../src/routing/HttpForwardingTransport';
import { RouteTarget } from '../../../src/routing/types';

const target: RouteTarget = {
  nodeId: 'node-2',
  address: '10.0.0.2',
  port: 8080,
  isLocal: false,
};

function makeResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(json),
    text: async () => json,
    headers: new Headers({ 'content-type': contentType }),
  } as unknown as Response;
}

describe('HttpForwardingTransport', () => {
  test('makes POST request with correct URL, headers, and body', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeResponse(200, { result: 'ok' }));
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    await transport.call(target, '/forward/room-1/join', { user: 'alice' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://10.0.0.2:8080/forward/room-1/join');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ user: 'alice' }));
  });

  test('merges custom headers into request', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeResponse(200, {}));
    const transport = new HttpForwardingTransport({
      fetchImpl: mockFetch,
      headers: { 'X-Node-Id': 'node-1' },
    });

    await transport.call(target, '/path', {});

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Node-Id']).toBe('node-1');
  });

  test('2xx response returns parsed JSON body', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeResponse(200, { data: 42 }));
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    const result = await transport.call(target, '/path', {});
    expect(result).toEqual({ data: 42 });
  });

  test('201 response also returns parsed JSON body', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeResponse(201, { created: true }));
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    const result = await transport.call(target, '/path', {});
    expect(result).toEqual({ created: true });
  });

  test('421 response throws MisdirectedError with owner info', async () => {
    const ownerBody = { owner: { address: '10.0.0.3', port: 9090 } };
    const mockFetch = jest.fn().mockResolvedValue(makeResponse(421, ownerBody));
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    const err = await transport.call(target, '/path', {}).catch((e) => e);
    expect(err).toBeInstanceOf(MisdirectedError);
    expect((err as MisdirectedError).owner).toEqual({ address: '10.0.0.3', port: 9090 });
  });

  test('421 response with no body still throws MisdirectedError with undefined owner', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 421,
      ok: false,
      json: async () => { throw new SyntaxError('not json'); },
      text: async () => '',
    } as unknown as Response);
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    const err = await transport.call(target, '/path', {}).catch((e) => e);
    expect(err).toBeInstanceOf(MisdirectedError);
    expect((err as MisdirectedError).owner).toBeUndefined();
  });

  test('500 response throws generic Error with status info', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeResponse(500, 'Internal Server Error', 'text/plain'));
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    await expect(transport.call(target, '/path', {})).rejects.toThrow(/HTTP 500/);
  });

  test('404 response throws Error', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeResponse(404, 'Not Found', 'text/plain'));
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    await expect(transport.call(target, '/path', {})).rejects.toThrow(/HTTP 404/);
  });

  test('AbortController timeout throws TimeoutError', async () => {
    const mockFetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    await expect(
      transport.call(target, '/path', {}, { timeoutMs: 10 })
    ).rejects.toThrow(TimeoutError);
  });

  test('TimeoutError message includes the timeout duration', async () => {
    const mockFetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    const err = await transport.call(target, '/path', {}, { timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toContain('50ms');
  });

  test('non-JSON 2xx body causes response.json() to throw', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
      text: async () => 'not json',
    } as unknown as Response);
    const transport = new HttpForwardingTransport({ fetchImpl: mockFetch });

    await expect(transport.call(target, '/path', {})).rejects.toThrow(SyntaxError);
  });
});
