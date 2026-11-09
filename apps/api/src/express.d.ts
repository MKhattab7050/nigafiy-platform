// Request-scoped context attached by middleware.
declare namespace Express {
  interface Request {
    id: string;
    auth?: import('./common/http.ts').AuthContext;
    collector?: import('./modules/ingest/schema.ts').CollectorContext;
  }
}
