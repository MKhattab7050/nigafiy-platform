import { migrate } from './migrate.ts';

const owner = process.env.DATABASE_URL;
const app = process.env.APP_DATABASE_URL;
if (!owner || !app) {
  console.error('DATABASE_URL and APP_DATABASE_URL are required');
  process.exit(1);
}
try {
  await migrate(owner, app, (m) => console.log(m));
  console.log('migrations up to date');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
