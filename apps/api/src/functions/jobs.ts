import { runJobsOnce } from '../jobs';
import { serverlessApp } from '../serverless';

/** Scheduled in netlify.toml: reconciles payments, assigns waiting vouchers, generates the monthly batch. */
export async function handler() {
  const { deps, orders, vouchers } = await serverlessApp();
  await runJobsOnce(deps, orders, vouchers);
  return { statusCode: 200 };
}
