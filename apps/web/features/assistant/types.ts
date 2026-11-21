// Response shapes of /api/v1/assistant/* (apps/api/src/modules/assistant/service.ts and settings.ts).

export interface AssistantStatus {
  available: boolean;
  model: string;
  keep_transcripts: boolean;
  configured: boolean;
  budget: { used: number; limit: number; window_hours: number };
  rate: { used: number; limit: number; window_minutes: number };
  tokens_24h: { input: number; output: number };
  my_tokens_24h: { input: number; output: number };
}

export interface Citation {
  marker: string;
  kind: string;
  id: string;
  label: string;
  href: string;
}

export interface Lookup {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  count: number | null;
  error?: string;
}

export interface AssistantAnswer {
  conversation_id: string;
  kind: 'ask' | 'explain_incident' | 'explain_doctor';
  text: string;
  citations: Citation[];
  sources: Citation[];
  lookups: Lookup[];
  model: string;
  usage: { input_tokens: number; output_tokens: number; api_calls: number; tool_calls: number };
  stop_reason: string | null;
  refused: boolean;
  truncated: boolean;
  transcript_stored: boolean;
  ai_generated: true;
  generated_at: string;
}

export interface AssistantSettings {
  enabled: boolean;
  available: boolean;
  api_key: { set: boolean; updated_at: string | null };
  model: string;
  models: string[];
  daily_request_budget: number;
  user_requests_per_hour: number;
  keep_transcripts: boolean;
  disclosure: { current_version: string; accepted_version: string | null; accepted: boolean; accepted_at: string | null; accepted_by_name: string | null };
  last_test: { at: string; ok: boolean | null; error: string | null } | null;
  updated_at: string | null;
}

export interface KeyTestResult {
  ok: boolean;
  model: string;
  latency_ms: number;
  error: string | null;
  error_code: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: number;
}

export interface ConversationDetail {
  id: string;
  title: string;
  created_at: string;
  messages: { id: string; role: 'user' | 'assistant'; text: string; citations: Citation[]; lookups: Lookup[]; created_at: string }[];
}
