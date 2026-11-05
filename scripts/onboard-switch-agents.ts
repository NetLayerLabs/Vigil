import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SwitchAgentClient } from '../src/protocol/switchClient.js';

async function main() {
  const switchUrl = (process.env.SWITCH_SERVER_URL ?? '').trim();
  const registrationKey = (process.env.SWITCH_REGISTRATION_KEY ?? '').trim();
  const team = (process.env.VIGIL_TEAM ?? 'vigil').trim();

  if (!switchUrl || !registrationKey) {
    console.error(
      'Usage: SWITCH_SERVER_URL=http://localhost:8000 SWITCH_REGISTRATION_KEY=<key> npm run onboard:switch',
    );
    process.exit(1);
  }

  console.log(`Probing Switch Bridge health at ${switchUrl}/health ...`);
  const healthy = await SwitchAgentClient.checkHealth(switchUrl);
  if (!healthy) {
    console.error(`Switch server at ${switchUrl} did not return 200 OK on GET /health.`);
    process.exit(1);
  }

  const specs = [
    {
      envPrefix: 'VIGIL_SENTINEL',
      name: `${team}-sentinel`,
      displayName: 'Vigil Sentinel',
      description: 'Autonomous Telemetry Correlator & Incident Commander',
    },
    {
      envPrefix: 'VIGIL_PATCHER',
      name: `${team}-patcher`,
      displayName: 'Vigil Patcher',
      description: 'Surgical Bug Reproducer & Regression Patcher',
    },
    {
      envPrefix: 'VIGIL_RELEASE_GATE',
      name: `${team}-release-gate`,
      displayName: 'Vigil Release Gate',
      description: 'Deterministic Human-in-the-Loop Release & Rollback Gatekeeper',
    },
  ];

  const envPath = path.resolve(process.cwd(), '.env');
  let envContent = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
    : readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');

  const upsertEnv = (key: string, value: string) => {
    const rx = new RegExp(`^${key}=.*$`, 'm');
    if (rx.test(envContent)) {
      envContent = envContent.replace(rx, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  };

  upsertEnv('SWITCH_SERVER_URL', switchUrl);
  upsertEnv('SWITCH_REGISTRATION_KEY', registrationKey);
  upsertEnv('VIGIL_TEAM', team);

  for (const s of specs) {
    console.log(`Registering @${s.name} via POST /agents ...`);
    const reg = await SwitchAgentClient.registerAgent(switchUrl, registrationKey, {
      name: s.name,
      display_name: s.displayName,
      description: s.description,
      connector_type: 'vigil-websocket-agent',
      overwrite: true,
      integration_profile: {
        connection_model: 'always_on',
        message_exchange: true,
        pre_invocation_mediation: [],
        post_invocation_mediation: [],
        event_reporting: [],
      },
    });
    upsertEnv(`${s.envPrefix}_AGENT_ID`, reg.id);
    upsertEnv(`${s.envPrefix}_API_KEY`, reg.api_key);
    console.log(`  ✓ ${s.name} -> id=${reg.id}`);
  }

  writeFileSync(envPath, envContent, 'utf8');
  console.log('\nSaved registered Switch Agent credentials to .env!');
  console.log('Next step:');
  console.log('  1. In Switch Console -> Templates -> Import template: upload templates/vigil-war-room.template.yaml');
  console.log('     (Select "Existing agent" on the 3 agent cards to attach these registered WebSocket agents, or swap');
  console.log('      vigil-patcher to Claude Code / Antigravity!)');
  console.log('  2. Start Vigil connected to your live Switch Server: npm run dev');
}

main().catch((err) => {
  console.error('Switch onboarding error:', err);
  process.exit(1);
});
