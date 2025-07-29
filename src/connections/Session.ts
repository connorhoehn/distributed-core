import { SessionMetadata, ConnectionTags } from './types';

export class Session {
  private metadata: SessionMetadata;
  private readonly createdAt: number;
  private tags: ConnectionTags = {};

  constructor(
    public readonly id: string,
    initialMetadata: SessionMetadata = {}
  ) {
    this.createdAt = Date.now();
    this.metadata = {
      connectedAt: this.createdAt,
      lastActivity: this.createdAt,
      authStatus: 'pending',
      ...initialMetadata
    };

    // Automatically convert common metadata fields to tags
    if (this.metadata.userId) {
      this.tags.userId = this.metadata.userId;
    }
    if (this.metadata.roomId) {
      this.tags.room = this.metadata.roomId;
    }
  }

  get(key: string): any {
    return this.metadata[key];
  }

  set(key: string, value: any): void {
    this.metadata[key] = value;
    this.updateLastActivity();
  }

  setMultiple(data: Partial<SessionMetadata>): void {
    Object.assign(this.metadata, data);
    this.updateLastActivity();
  }

  has(key: string): boolean {
    return key in this.metadata;
  }

  remove(key: string): void {
    delete this.metadata[key];
    this.updateLastActivity();
  }

  getAll(): Readonly<SessionMetadata> {
    return { ...this.metadata };
  }

  updateLastActivity(): void {
    this.metadata.lastActivity = Date.now();
  }

  markClosed(): void {
    this.metadata.closed = true;
    this.metadata.closedAt = Date.now();
  }

  isClosed(): boolean {
    return !!this.metadata.closed;
  }

  isAuthenticated(): boolean {
    return this.metadata.authStatus === 'authenticated';
  }

  getAge(): number {
    return Date.now() - this.createdAt;
  }

  getIdleTime(): number {
    return Date.now() - (this.metadata.lastActivity || this.createdAt);
  }

  // Role management helpers
  hasRole(role: string): boolean {
    const roles = this.metadata.roles || [];
    return roles.includes(role);
  }

  addRole(role: string): void {
    const roles = new Set(this.metadata.roles || []);
    roles.add(role);
    this.metadata.roles = Array.from(roles);
    this.updateLastActivity();
  }

  removeRole(role: string): void {
    const roles = this.metadata.roles || [];
    this.metadata.roles = roles.filter((r: any) => r !== role);
    this.updateLastActivity();
  }

  // Tag management methods
  setTag(key: string, value: string | string[]): void {
    this.tags[key] = value;
    this.updateLastActivity();
  }

  getTag(key: string): string | string[] | undefined {
    return this.tags[key];
  }

  getTags(): ConnectionTags {
    return { ...this.tags };
  }

  hasTag(key: string, value?: string): boolean {
    const tagValue = this.tags[key];
    if (!tagValue) return false;
    
    if (value === undefined) return true;
    
    if (Array.isArray(tagValue)) {
      return tagValue.includes(value);
    }
    
    return tagValue === value;
  }

  removeTag(key: string): void {
    delete this.tags[key];
    this.updateLastActivity();
  }

  addTagValue(key: string, value: string): void {
    const existing = this.tags[key];
    if (!existing) {
      this.tags[key] = value;
    } else if (Array.isArray(existing)) {
      if (!existing.includes(value)) {
        existing.push(value);
      }
    } else if (existing !== value) {
      this.tags[key] = [existing, value];
    }
    this.updateLastActivity();
  }

  removeTagValue(key: string, value: string): void {
    const existing = this.tags[key];
    if (!existing) return;
    
    if (Array.isArray(existing)) {
      const index = existing.indexOf(value);
      if (index > -1) {
        existing.splice(index, 1);
        if (existing.length === 1) {
          this.tags[key] = existing[0];
        } else if (existing.length === 0) {
          delete this.tags[key];
        }
      }
    } else if (existing === value) {
      delete this.tags[key];
    }
    this.updateLastActivity();
  }
}
