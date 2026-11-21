import { defineModule } from '../../infrastructure/module.ts';
import { eventsRouter } from './routes.ts';

/** The event timeline and audit log: GET /events, GET /audit-logs; emitEvent() for every other module. */
export const eventsModule = defineModule({ name: 'events', api: eventsRouter });

export { type NewEvent, emitEvent } from './emit.ts';
export { EVENT_SELECT } from './queries.ts';
