import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { SwitchServerHarness } from './mock-switch/switchServerHarness.js';
import { CheckoutMicroservice, FAULT_CATALOG, FaultScenarioId } from './services/checkoutSandbox.js';
import { VigilMeshCoordinator } from './agents/vigilMeshCoordinator.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function startVigilRuntime(opts: {
  vigilPort?: number;
  checkoutPort?: number;
  externalSwitchUrl?: string;
  registrationKey?: string;
  teamPrefix?: string;
} = {}) {
  const vigilPort = opts.vigilPort ?? Number(process.env.VIGIL_PORT || 4010);
  const checkoutPort = opts.checkoutPort ?? Number(process.env.CHECKOUT_API_PORT || 4020);
  const externalSwitchUrl = (opts.externalSwitchUrl ?? process.env.SWITCH_SERVER_URL ?? '').trim();
  const teamPrefix = opts.teamPrefix ?? process.env.VIGIL_TEAM ?? 'vigil';
  const registrationKey =
    opts.registrationKey ?? process.env.SWITCH_REGISTRATION_KEY ?? 'switch-reg-vigil-local-key';

  let broadcastState = () => {};

  // 1. Start Target Checkout & Cart Pricing Microservice
  const checkoutService = new CheckoutMicroservice();
  const boundCheckoutPort = await checkoutService.start(checkoutPort);

  // 2. Start Embedded Spec-Exact Switch Protocol Server OR attach to live Switch Console Server!
  let embeddedSwitch: SwitchServerHarness | null = null;
  let switchServerUrl = externalSwitchUrl;

  if (!switchServerUrl) {
    embeddedSwitch = new SwitchServerHarness({
      registrationKey,
      pingIntervalMs: 2500,
      heartbeatTtlMs: 8000,
      onStateChange: () => broadcastState(),
    });
    await embeddedSwitch.start(0);
    switchServerUrl = embeddedSwitch.getBaseUrl();
  }

  // 3. Bootstrap the 3 WebSocket Switch Agents & Linked 3-Room Incident Mesh
  const preRegisteredCreds =
    process.env.VIGIL_SENTINEL_AGENT_ID && process.env.VIGIL_SENTINEL_API_KEY
      ? {
          sentinel: {
            id: process.env.VIGIL_SENTINEL_AGENT_ID,
            api_key: process.env.VIGIL_SENTINEL_API_KEY,
          },
          patcher:
            process.env.VIGIL_PATCHER_AGENT_ID && process.env.VIGIL_PATCHER_API_KEY
              ? {
                  id: process.env.VIGIL_PATCHER_AGENT_ID,
                  api_key: process.env.VIGIL_PATCHER_API_KEY,
                }
              : undefined,
          releaseGate:
            process.env.VIGIL_RELEASE_GATE_AGENT_ID && process.env.VIGIL_RELEASE_GATE_API_KEY
              ? {
                  id: process.env.VIGIL_RELEASE_GATE_AGENT_ID,
                  api_key: process.env.VIGIL_RELEASE_GATE_API_KEY,
                }
              : undefined,
        }
      : undefined;

  const coordinator = new VigilMeshCoordinator({
    switchServerUrl,
    registrationKey,
    teamPrefix,
    bridgeName: 'Mattermost',
    creatorUsername: 'priya',
    externalCoderHandle: process.env.SWITCH_CONSOLE_CODER_HANDLE || undefined,
    patchMode:
      process.env.VIGIL_PATCH_MODE === 'external' || process.env.VIGIL_PATCH_MODE === 'auto'
        ? process.env.VIGIL_PATCH_MODE
        : undefined,
    checkoutService,
    preRegisteredCreds,
    provisionTemplateViaApi: Boolean(embeddedSwitch) || process.env.PROVISION_TEMPLATE === 'true',
    onEventUpdate: () => broadcastState(),
  });

  await coordinator.bootstrap();

  // 4. Start Vigil Observatory HTTP + Live Stream Server
  const uiClients = new Set<WebSocket>();

  const buildObservatorySnapshot = async () => {
    let switchSnapshot;
    if (embeddedSwitch) {
      switchSnapshot = embeddedSwitch.getSnapshot();
    } else {
      // Live Switch Server mode: query room details & recent messages via SwitchAgentClient ops!
      const roomList = await coordinator.sentinelClient.listRooms();
      const patcherRooms = await coordinator.patcherClient.listRooms();
      const byId = new Map<string, typeof roomList[number]>();
      for (const r of [...roomList, ...patcherRooms]) byId.set(r.id, r);

      const roomsWithMessages = await Promise.all(
        Array.from(byId.values()).map(async (r) => {
          try {
            const client = r.name.includes('hotfix')
              ? coordinator.patcherClient
              : coordinator.sentinelClient;
            const ctx = await client.readContext(r.id, 40);
            return {
              ...ctx.room,
              messages: ctx.messages.map((m) => ({
                ...m,
                room_id: r.id,
                room_name: r.name,
              })),
            };
          } catch {
            return { ...r, messages: [] };
          }
        }),
      );

      const links = roomsWithMessages.flatMap((r) => r.links ?? []);
      switchSnapshot = {
        rooms: roomsWithMessages,
        links,
        agents: [
          {
            id: coordinator.sentinelClient.agentId,
            name: coordinator.sentinelClient.agentName,
            displayName: 'Vigil Sentinel',
            description: 'Telemetry Correlator & Incident Commander',
            participantId: `@switch-agent-${coordinator.sentinelClient.agentName}`,
            online: !coordinator.sentinelClient.isStoppedPermanently(),
            cursor: coordinator.sentinelClient.getCursor(),
            generation: coordinator.sentinelClient.getGeneration() ?? null,
          },
          {
            id: coordinator.patcherClient.agentId,
            name: coordinator.patcherClient.agentName,
            displayName: 'Vigil Patcher',
            description: 'Surgical Bug Reproducer & Regression Patcher',
            participantId: `@switch-agent-${coordinator.patcherClient.agentName}`,
            online: !coordinator.patcherClient.isStoppedPermanently(),
            cursor: coordinator.patcherClient.getCursor(),
            generation: coordinator.patcherClient.getGeneration() ?? null,
          },
          {
            id: coordinator.releaseGateClient.agentId,
            name: coordinator.releaseGateClient.agentName,
            displayName: 'Vigil Release Gate',
            description: 'Deterministic Human Release Gatekeeper',
            participantId: `@switch-agent-${coordinator.releaseGateClient.agentName}`,
            online: !coordinator.releaseGateClient.isStoppedPermanently(),
            cursor: coordinator.releaseGateClient.getCursor(),
            generation: coordinator.releaseGateClient.getGeneration() ?? null,
          },
        ],
      };
    }

    return {
      mode: embeddedSwitch ? 'embedded_switch_protocol_server' : 'live_switch_console_server',
      switchServerUrl,
      checkoutBaseUrl: checkoutService.getBaseUrl(),
      checkoutTelemetry: checkoutService.getTelemetry(),
      faultCatalog: FAULT_CATALOG,
      switchState: switchSnapshot,
      incidents: coordinator.getIncidents(),
      activeIncident: coordinator.getActiveIncident(),
      wireTraces: coordinator.getWireTraces().slice(0, 80),
      roomIds: coordinator.getRoomIds(),
      patchMode: coordinator.getPatchMode(),
      externalCoderHandle: coordinator.getExternalCoderHandle(),
      releasePolicy: coordinator.getReleasePolicy(),
      policyAudit: coordinator.getPolicyAudit(),
      failovers: coordinator.getFailovers(),
      retiredSentinels: coordinator.getRetiredSentinels(),
    };
  };

  let debounceTimer: NodeJS.Timeout | null = null;
  broadcastState = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      if (uiClients.size === 0) return;
      try {
        const snap = await buildObservatorySnapshot();
        const payload = JSON.stringify({ type: 'observatory_snapshot', data: snap });
        for (const ws of uiClients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
          }
        }
      } catch {
        // ignore transient broadcast error
      }
    }, 60);
  };

  const uiDistDir = path.resolve(process.cwd(), 'dist/ui');

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
      res.end();
      return;
    }

    try {
      if (method === 'GET' && url.pathname === '/api/state') {
        const snap = await buildObservatorySnapshot();
        sendJson(res, 200, snap);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/templates') {
        const warRoomYaml = readFileSync(
          path.resolve(process.cwd(), 'templates/vigil-war-room.template.yaml'),
          'utf8',
        );
        const hotfixYaml = readFileSync(
          path.resolve(process.cwd(), 'templates/vigil-hotfix-workroom.template.yaml'),
          'utf8',
        );
        sendJson(res, 200, {
          warRoomTemplate: warRoomYaml,
          hotfixWorkroomTemplate: hotfixYaml,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/chaos/inject') {
        const body = (await readJson(req)) as { scenarioId?: FaultScenarioId };
        const scenarioId: FaultScenarioId = body.scenarioId ?? 'jpy_zero_decimal_500';
        if (!FAULT_CATALOG[scenarioId]) {
          sendJson(res, 400, { error: `Unknown scenarioId: ${scenarioId}` });
          return;
        }
        const alert = await checkoutService.injectFaultRelease(scenarioId);
        broadcastState();
        sendJson(res, 200, { ok: true, alert });
        return;
      }

      // Patcher routing: Vigil's own patcher vs. an external coding agent bound through Switch Console
      if (method === 'POST' && url.pathname === '/api/patch-mode') {
        const body = (await readJson(req)) as { mode?: string };
        if (body.mode !== 'auto' && body.mode !== 'external') {
          sendJson(res, 400, { error: "mode must be 'auto' or 'external'" });
          return;
        }
        coordinator.setPatchMode(body.mode);
        broadcastState();
        sendJson(res, 200, { ok: true, patchMode: coordinator.getPatchMode() });
        return;
      }

      // External coder intake (Claude Code / Codex / Antigravity): verify a submitted unified diff
      const stageMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/stage-patch$/);
      if (method === 'POST' && stageMatch) {
        const incidentId = decodeURIComponent(stageMatch[1]).toUpperCase();
        const body = (await readJson(req)) as {
          diffUnified?: string;
          diff?: string;
          author?: string;
          touchedFiles?: string[];
        };
        const diff = (body.diffUnified ?? body.diff ?? '').trim();
        if (!diff) {
          sendJson(res, 400, { error: 'diffUnified (unified diff text) is required' });
          return;
        }
        try {
          const verification = await coordinator.stageExternalPatchViaApi(incidentId, {
            diffUnified: diff,
            author: body.author,
            touchedFiles: body.touchedFiles,
          });
          broadcastState();
          sendJson(res, verification.allPassed ? 200 : 422, {
            ok: verification.allPassed,
            incidentId,
            verification,
            next: verification.allPassed
              ? `Handed off to #${coordinator.teamPrefix}-releases; a human must reply 'approve ${incidentId} promote'.`
              : 'Candidate rejected by the regression matrix; submit a corrected diff.',
          });
        } catch (err) {
          sendJson(res, 404, { error: (err as Error).message });
        }
        return;
      }

      // Reference fix for an incident (lets a demo operator paste the known-good diff into the intake form)
      const refMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/reference-fix$/);
      if (method === 'GET' && refMatch) {
        const incidentId = decodeURIComponent(refMatch[1]).toUpperCase();
        const rec = coordinator.getIncidents().find((i) => i.incidentId === incidentId);
        if (!rec) {
          sendJson(res, 404, { error: `Unknown incident ${incidentId}` });
          return;
        }
        const spec = FAULT_CATALOG[rec.scenarioId];
        sendJson(res, 200, {
          incidentId,
          scenarioId: rec.scenarioId,
          filePath: spec.filePath,
          line: spec.line,
          reproPayload: spec.reproPayload,
          diffUnified: spec.diffUnified,
          fixSignatures: spec.fixSignatures.map((f) => f.label),
        });
        return;
      }

      // Chaos: wedge the incident commander, then fail over to a standby sentinel (same connection_id)
      if (method === 'POST' && url.pathname === '/api/chaos/crash-sentinel') {
        const info = coordinator.crashSentinel();
        broadcastState();
        sendJson(res, 200, { ok: true, hung: info });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/chaos/failover-sentinel') {
        const record = await coordinator.failoverSentinel();
        broadcastState();
        sendJson(res, 200, { ok: true, failover: record });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/chat/message') {
        const body = (await readJson(req)) as {
          roomId: string;
          username?: string;
          displayName?: string;
          content: string;
        };
        if (!body.roomId || !body.content?.trim()) {
          sendJson(res, 400, { error: 'roomId and content are required' });
          return;
        }

        if (embeddedSwitch) {
          const forwardRes = await fetch(`${switchServerUrl}/gateway/human-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              room_id: body.roomId,
              username: body.username ?? 'priya',
              display_name: body.displayName ?? 'Priya (On-Call Lead)',
              content: body.content,
            }),
          });
          const result = await forwardRes.json();
          broadcastState();
          sendJson(res, forwardRes.status, result);
          return;
        } else {
          sendJson(res, 400, {
            error:
              'Connected to live external Switch Server: post human messages directly in Mattermost, Discord, Telegram, or Slack!',
          });
          return;
        }
      }

      // Serve built React Observatory UI if present
      if ((method === 'GET' || method === 'HEAD') && existsSync(uiDistDir)) {
        const requested = url.pathname === '/' ? '/index.html' : url.pathname;
        const candidatePath = path.join(uiDistDir, path.normalize(requested));
        if (
          candidatePath.startsWith(uiDistDir) &&
          existsSync(candidatePath) &&
          statSync(candidatePath).isFile()
        ) {
          const ext = path.extname(candidatePath);
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
          res.end(method === 'HEAD' ? undefined : readFileSync(candidatePath));
          return;
        }
        const indexHtml = path.join(uiDistDir, 'index.html');
        if (existsSync(indexHtml)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(method === 'HEAD' ? undefined : readFileSync(indexHtml));
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found. Run `npm run build:ui` or open Vite dev server.' });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });

  const uiWss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/ws/observatory') {
      uiWss.handleUpgrade(req, socket, head, async (ws) => {
        uiClients.add(ws);
        ws.on('close', () => uiClients.delete(ws));
        const snap = await buildObservatorySnapshot();
        ws.send(JSON.stringify({ type: 'observatory_snapshot', data: snap }));
      });
    } else {
      socket.destroy();
    }
  });

  let boundVigilPort = vigilPort;
  await new Promise<void>((resolve) => {
    httpServer.listen(vigilPort, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') {
        boundVigilPort = addr.port;
      }
      resolve();
    });
  });

  return {
    vigilUrl: `http://localhost:${boundVigilPort}`,
    checkoutUrl: `http://localhost:${boundCheckoutPort}`,
    switchServerUrl,
    mode: embeddedSwitch ? 'embedded' : 'live',
    coordinator,
    checkoutService,
    embeddedSwitch,
    stop: async () => {
      for (const c of uiClients) c.close();
      await new Promise<void>((r) => uiWss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
      await coordinator.shutdown();
      await checkoutService.stop();
      if (embeddedSwitch) await embeddedSwitch.stop();
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

// Direct CLI entrypoint when executed via `npm run dev` or `npm start`
const isDirectEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('src/index.ts') || process.argv[1].endsWith('dist/server/index.js'));

if (isDirectEntry) {
  startVigilRuntime()
    .then((runtime) => {
      console.log('====================================================================');
      console.log('⚡ Vigil — Autonomous Incident-to-Hotfix War Room on Switch');
      console.log('====================================================================');
      console.log(`• Observatory & API   : ${runtime.vigilUrl}`);
      console.log(`• Checkout API Target : ${runtime.checkoutUrl}/health`);
      console.log(`• Switch Bridge Mode  : ${runtime.mode.toUpperCase()} (${runtime.switchServerUrl})`);
      console.log(`• Patch Mode          : ${runtime.coordinator.getPatchMode().toUpperCase()} (external coder handle: @${runtime.coordinator.getExternalCoderHandle()})`);
      console.log('• Connected Agents    : vigil-sentinel, vigil-patcher, vigil-release-gate');
      console.log('• Linked Switch Rooms : #vigil-incidents -> #vigil-hotfix -> #vigil-releases');
      console.log('====================================================================');
    })
    .catch((err) => {
      console.error('Failed to start Vigil runtime:', err);
      process.exit(1);
    });
}
