import { defineModule } from '../../infrastructure/module.ts';
import { toolboxRouter } from './routes.ts';

/** IT toolbox: on-demand ping / TCP / port / DNS / traceroute runs executed by a site's collector. */
export const toolboxModule = defineModule({ name: 'toolbox', api: toolboxRouter });

export { processToolResult } from './ingest.ts';
export { TOOL_KINDS, type ToolRunQueued, type ToolRunState, assertToolTarget, queueToolRun, toolRunState } from './queue.ts';
