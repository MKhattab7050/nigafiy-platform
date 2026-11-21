// Request-scoped context attached by middleware.
declare namespace Express {
  interface Request {
    id: string;
    auth?: import('./common/http.ts').AuthContext;
    collector?: import('./common/collector-protocol.ts').CollectorContext;
    endpoint?: import('./modules/endpoints/index.ts').EndpointContext;
  }
}
