import { FaultScenarioId } from '../src/services/checkoutSandbox.js';

const scenario = (process.argv[2] ?? 'jpy_zero_decimal_500') as FaultScenarioId;
const vigilUrl = process.env.VIGIL_URL ?? 'http://localhost:4010';

async function main() {
  console.log(`Injecting chaos scenario '${scenario}' via ${vigilUrl}/api/chaos/inject ...`);
  const res = await fetch(`${vigilUrl}/api/chaos/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: scenario }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error('Fault injection failed:', body);
    process.exit(1);
  }
  console.log('Incident triggered across Switch Rooms:', JSON.stringify(body.alert, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
