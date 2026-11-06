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
      description: 'Watches checkout-api, opens incidents and leads them',
    },
    {
      envPrefix: 'VIGIL_PATCHER',
      name: `${team}-patcher`,
      displayName: 'Vigil Patcher',
      description: 'Reproduces the bug, fixes or checks the fix, runs the tests',
    },
    {
      envPrefix: 'VIGIL_RELEASE_GATE',
      name: `${team}-release-gate`,
      displayName: 'Vigil Release Gate',
      description: 'Ships or rolls back only when a person approves',
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

    // Who may address each agent is set when Vigil starts: Switch only accepts that change from an
    // agent with an open connection, and never from the agent itself, so the agents set it for each other.
  }

  writeFileSync(envPath, envContent, 'utf8');
  console.log('\nSaved registered Switch Agent credentials to .env!');
  console.log('Next step: start Vigil against this Switch server (npm run dev, or npm start after a build).');
  console.log('On first start Vigil:');
  console.log(`  - lets any human teammate and the sibling agents address ${team}-sentinel, ${team}-patcher and ${team}-release-gate;`);
  console.log(`  - creates #${team}-incidents, #${team}-hotfix and #${team}-releases (roles, documents, links) from`);
  console.log('    templates/vigil-war-room.template.yaml through the create_room_from_yaml operation.');
  console.log('Optional: bind Claude Code / Codex into #' + team + '-hotfix with Switch Console and set');
  console.log('  SWITCH_CONSOLE_CODER_HANDLE=<its agent name> so vigil-patcher becomes the verifier (CLAUDE.md briefs it).');
}

main().catch((err) => {
  console.error('Switch onboarding error:', err);
  process.exit(1);
});
