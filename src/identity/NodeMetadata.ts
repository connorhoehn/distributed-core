export class NodeMetadata {
  constructor(
    public readonly nodeId: string,
    public readonly clusterId: string,
    public readonly service: string,
    public readonly zone: string,            // "us-east-1a"
    public readonly region: string,          // "us-east-1"
    public readonly pubKey: string,          // for auth
    public readonly startTime: number = Date.now(),
    public readonly incarnation: number = 0,
    public readonly version: string = "v1.0.0"
  ) {}
}
