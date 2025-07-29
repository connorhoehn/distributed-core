import { Session } from '../Session';

describe('Session', () => {
  let session: Session;

  beforeEach(() => {
    session = new Session('test-session-1');
  });

  describe('initialization', () => {
    it('should create session with id', () => {
      expect(session.id).toBe('test-session-1');
    });

    it('should set default metadata', () => {
      expect(session.get('connectedAt')).toBeGreaterThan(0);
      expect(session.get('lastActivity')).toBeGreaterThan(0);
      expect(session.get('authStatus')).toBe('pending');
    });

    it('should accept initial metadata', () => {
      const sessionWithMeta = new Session('test-2', { userId: 'user123', roomId: 'room456' });
      expect(sessionWithMeta.get('userId')).toBe('user123');
      expect(sessionWithMeta.get('roomId')).toBe('room456');
    });
  });

  describe('metadata management', () => {
    it('should set and get values', () => {
      session.set('userId', 'user123');
      expect(session.get('userId')).toBe('user123');
    });

    it('should check if key exists', () => {
      session.set('test', 'value');
      expect(session.has('test')).toBe(true);
      expect(session.has('nonexistent')).toBe(false);
    });

    it('should remove values', () => {
      session.set('temp', 'value');
      expect(session.has('temp')).toBe(true);
      session.remove('temp');
      expect(session.has('temp')).toBe(false);
    });

    it('should set multiple values', () => {
      session.setMultiple({ userId: 'user123', roomId: 'room456', role: 'admin' });
      expect(session.get('userId')).toBe('user123');
      expect(session.get('roomId')).toBe('room456');
      expect(session.get('role')).toBe('admin');
    });

    it('should get all metadata', () => {
      session.set('userId', 'user123');
      const all = session.getAll();
      expect(all.userId).toBe('user123');
      expect(all.connectedAt).toBeDefined();
    });

    it('should return immutable copy from getAll', () => {
      session.set('test', 'original');
      const all = session.getAll();
      // Try to modify the returned object (should not affect original)
      (all as any).test = 'modified';
      expect(session.get('test')).toBe('original');
    });
  });

  describe('activity tracking', () => {
    it('should update last activity when setting values', () => {
      const originalActivity = session.get('lastActivity');
      
      // Wait a bit to ensure timestamp difference
      setTimeout(() => {
        session.set('test', 'value');
        expect(session.get('lastActivity')).toBeGreaterThan(originalActivity);
      }, 10);
    });

    it('should calculate age correctly', () => {
      const age = session.getAge();
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(1000); // Should be very recent
    });

    it('should calculate idle time correctly', () => {
      const idleTime = session.getIdleTime();
      expect(idleTime).toBeGreaterThanOrEqual(0);
      expect(idleTime).toBeLessThan(1000); // Should be very recent
    });
  });

  describe('session state', () => {
    it('should mark session as closed', () => {
      expect(session.isClosed()).toBe(false);
      session.markClosed();
      expect(session.isClosed()).toBe(true);
      expect(session.get('closed')).toBe(true);
      expect(session.get('closedAt')).toBeGreaterThan(0);
    });

    it('should check authentication status', () => {
      expect(session.isAuthenticated()).toBe(false);
      session.set('authStatus', 'authenticated');
      expect(session.isAuthenticated()).toBe(true);
    });
  });

  describe('role management', () => {
    it('should check for roles', () => {
      expect(session.hasRole('admin')).toBe(false);
      session.set('roles', ['user', 'admin']);
      expect(session.hasRole('admin')).toBe(true);
      expect(session.hasRole('user')).toBe(true);
      expect(session.hasRole('superuser')).toBe(false);
    });

    it('should add roles', () => {
      session.addRole('user');
      expect(session.hasRole('user')).toBe(true);
      
      session.addRole('admin');
      expect(session.hasRole('admin')).toBe(true);
      expect(session.get('roles')).toEqual(['user', 'admin']);
    });

    it('should not add duplicate roles', () => {
      session.addRole('user');
      session.addRole('user');
      expect(session.get('roles')).toEqual(['user']);
    });

    it('should remove roles', () => {
      session.set('roles', ['user', 'admin', 'moderator']);
      session.removeRole('admin');
      expect(session.get('roles')).toEqual(['user', 'moderator']);
      expect(session.hasRole('admin')).toBe(false);
    });

    it('should handle empty roles array', () => {
      expect(session.hasRole('any')).toBe(false);
      session.addRole('first');
      expect(session.hasRole('first')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle undefined values', () => {
      session.set('undefined', undefined);
      expect(session.get('undefined')).toBeUndefined();
      expect(session.has('undefined')).toBe(true);
    });

    it('should handle null values', () => {
      session.set('null', null);
      expect(session.get('null')).toBeNull();
      expect(session.has('null')).toBe(true);
    });

    it('should handle complex objects', () => {
      const complexObj = { nested: { data: [1, 2, 3] } };
      session.set('complex', complexObj);
      expect(session.get('complex')).toEqual(complexObj);
    });
  });
});
