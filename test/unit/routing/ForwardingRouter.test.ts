import { ForwardingRouter, ForwardingTransport, LocalResourceError, UnroutableResourceError } from '../../../src/routing/ForwardingRouter';
import { MisdirectedError } from '../../../src/routing/HttpForwardingTransport';
import { RouteTarget } from '../../../src/routing/types';

function makeRouter(routeResult: RouteTarget | null | Array<RouteTarget | null>) {
  const results = Array.isArray(routeResult) ? [...routeResult] : null;
  const single = Array.isArray(routeResult) ? null : routeResult;
  let callCount = 0;

  return {
    route: jest.fn(async (_resourceId: string) => {
      if (results !== null) {
        const val = results[callCount] ?? results[results.length - 1];
        callCount++;
        return val;
      }
      return single;
    }),
    isLocal: jest.fn(() => false),
  } as unknown as import('../../../src/routing/ResourceRouter').ResourceRouter;
}

const remoteTarget: RouteTarget = {
  nodeId: 'node-2',
  address: '10.0.0.2',
  port: 8080,
  isLocal: false,
};

const localTarget: RouteTarget = {
  nodeId: 'node-1',
  address: '',
  port: 0,
  isLocal: true,
};

describe('ForwardingRouter', () => {
  let mockTransport: ForwardingTransport;

  beforeEach(() => {
    mockTransport = {
      call: jest.fn(),
    };
  });

  test('local resource throws LocalResourceError', async () => {
    const router = makeRouter(localTarget);
    const fr = new ForwardingRouter(router, mockTransport);

    await expect(fr.call('res-1', '/action', {})).rejects.toThrow(LocalResourceError);
    await expect(fr.call('res-1', '/action', {})).rejects.toThrow('"res-1"');
    expect(mockTransport.call).not.toHaveBeenCalled();
  });

  test('unknown resource throws UnroutableResourceError', async () => {
    const router = makeRouter(null);
    const fr = new ForwardingRouter(router, mockTransport);

    await expect(fr.call('res-x', '/action', {})).rejects.toThrow(UnroutableResourceError);
    await expect(fr.call('res-x', '/action', {})).rejects.toThrow('"res-x"');
    expect(mockTransport.call).not.toHaveBeenCalled();
  });

  test('remote resource calls transport with correct args', async () => {
    const router = makeRouter(remoteTarget);
    (mockTransport.call as jest.Mock).mockResolvedValue({ ok: true });
    const fr = new ForwardingRouter(router, mockTransport, { timeoutMs: 3000 });

    const result = await fr.call('res-1', '/join', { user: 'alice' });

    expect(result).toEqual({ ok: true });
    expect(mockTransport.call).toHaveBeenCalledWith(
      remoteTarget,
      '/join',
      { user: 'alice' },
      { timeoutMs: 3000 }
    );
  });

  test('default timeoutMs of 5000 is passed to transport', async () => {
    const router = makeRouter(remoteTarget);
    (mockTransport.call as jest.Mock).mockResolvedValue({});
    const fr = new ForwardingRouter(router, mockTransport);

    await fr.call('res-1', '/ping', null);

    expect(mockTransport.call).toHaveBeenCalledWith(
      remoteTarget,
      '/ping',
      null,
      { timeoutMs: 5000 }
    );
  });

  test('MisdirectedError triggers re-route and retry, succeeds on second attempt', async () => {
    const newTarget: RouteTarget = { nodeId: 'node-3', address: '10.0.0.3', port: 9090, isLocal: false };
    const router = makeRouter([remoteTarget, newTarget]);
    (mockTransport.call as jest.Mock)
      .mockRejectedValueOnce(new MisdirectedError())
      .mockResolvedValueOnce({ ok: 'retry' });

    const fr = new ForwardingRouter(router, mockTransport, { retries: 1 });
    const result = await fr.call('res-1', '/action', {});

    expect(result).toEqual({ ok: 'retry' });
    expect(router.route).toHaveBeenCalledTimes(2);
    expect(mockTransport.call).toHaveBeenCalledTimes(2);
    expect((mockTransport.call as jest.Mock).mock.calls[1][0]).toEqual(newTarget);
  });

  test('retries exhausted re-throws MisdirectedError', async () => {
    const router = makeRouter([remoteTarget, remoteTarget]);
    const misdirected = new MisdirectedError();
    (mockTransport.call as jest.Mock).mockRejectedValue(misdirected);

    const fr = new ForwardingRouter(router, mockTransport, { retries: 1 });

    await expect(fr.call('res-1', '/action', {})).rejects.toBe(misdirected);
    expect(mockTransport.call).toHaveBeenCalledTimes(2);
  });

  test('non-MisdirectedError is propagated without retry', async () => {
    const router = makeRouter(remoteTarget);
    const err = new Error('network failure');
    (mockTransport.call as jest.Mock).mockRejectedValue(err);

    const fr = new ForwardingRouter(router, mockTransport, { retries: 3 });

    await expect(fr.call('res-1', '/action', {})).rejects.toBe(err);
    expect(mockTransport.call).toHaveBeenCalledTimes(1);
  });

  test('custom timeoutMs in config is passed through to transport', async () => {
    const router = makeRouter(remoteTarget);
    (mockTransport.call as jest.Mock).mockResolvedValue({});
    const fr = new ForwardingRouter(router, mockTransport, { timeoutMs: 1234 });

    await fr.call('res-1', '/path', 'data');

    expect(mockTransport.call).toHaveBeenCalledWith(
      remoteTarget,
      '/path',
      'data',
      { timeoutMs: 1234 }
    );
  });
});
