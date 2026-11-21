import { defineModule } from '../../infrastructure/module.ts';
import { impactRouter } from './routes.ts';

/**
 * Digital twin: failure impact simulation and single points of failure, on a dependency graph built
 * from stored evidence (topology, collectors, checks, managed computers, router Wi-Fi clients).
 *
 *   graph.ts   pure: building the graph, reachability, articulation points, simulation, SPOF ranking
 *   repo.ts    loads one site's twin inside the tenant transaction (reuses topology's buildTopology)
 *   routes.ts  GET /impact/graph, POST /impact/simulate, GET /impact/spof, GET /impact/devices/:id
 */
export const impactModule = defineModule({ name: 'impact', api: impactRouter });
