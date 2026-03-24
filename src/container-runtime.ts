/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/** Hostname/IP containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

/**
 * Detect the IP that Apple Container VMs use to reach the host.
 * Apple Container uses vmnet (192.168.64.0/24) — the host is always 192.168.64.1.
 * Older versions used bridge100, but current macOS uses vmnet without a visible
 * host-side interface. We probe the container to confirm, with 192.168.64.1 as default.
 * Falls back to 'host.docker.internal' for Docker.
 */
function detectAppleContainerHostIP(): string | null {
  if (os.platform() !== 'darwin') return null;
  if (CONTAINER_RUNTIME_BIN !== 'container') return null;

  const ifaces = os.networkInterfaces();

  // Check bridge100 first (older Apple Container versions)
  const bridge = ifaces['bridge100'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }

  // Modern Apple Container: vmnet gateway is 192.168.64.1 (no host-side interface visible).
  // Probe it by running a quick container to confirm.
  try {
    const result = execSync(
      'container run --rm alpine sh -c "ip route | head -1"',
      { timeout: 10000, encoding: 'utf-8' },
    ).trim();
    const gwMatch = result.match(/via\s+([\d.]+)/);
    if (gwMatch) {
      logger.info({ gateway: gwMatch[1] }, 'Detected Apple Container gateway via probe');
      return gwMatch[1];
    }
  } catch {
    logger.warn('Apple Container gateway probe failed, using default 192.168.64.1');
  }

  // Hardcoded default for Apple Container vmnet
  return '192.168.64.1';
}

function detectHostGateway(): string {
  return detectAppleContainerHostIP() || 'host.docker.internal';
}

function detectProxyBindHost(): string {
  // Apple Container: vmnet gateway (192.168.64.1) is not a real host interface,
  // so we can't bind to it directly. Bind to 0.0.0.0 instead — the container
  // reaches us via the vmnet gateway which routes to the host's network stack.
  const containerHostIP = detectAppleContainerHostIP();
  if (containerHostIP) return '0.0.0.0';

  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/**
 * Startup self-diagnostic for container networking.
 * Verifies: gateway detected, proxy bound, container runtime available.
 * Full end-to-end test (container → proxy) runs in background monitor on first Tier 1 check.
 */
export function verifyContainerNetworking(proxyPort: number): boolean {
  const gateway = CONTAINER_HOST_GATEWAY;
  const bindHost = PROXY_BIND_HOST;

  const issues: string[] = [];

  // 1. Gateway must be an IP, not a hostname (hostnames cause ENOTFOUND in containers)
  if (gateway === 'host.docker.internal') {
    issues.push(`Gateway is 'host.docker.internal' — Apple Container VMs cannot resolve this`);
  }

  // 2. Proxy must not bind to 127.0.0.1 on Apple Container (VMs can't reach loopback)
  if (CONTAINER_RUNTIME_BIN === 'container' && bindHost === '127.0.0.1') {
    issues.push(`Proxy bound to 127.0.0.1 — Apple Container VMs cannot reach loopback`);
  }

  // 3. Container runtime must be available
  try {
    execSync(`which ${CONTAINER_RUNTIME_BIN}`, { timeout: 5000, encoding: 'utf-8' });
  } catch {
    issues.push(`Container runtime '${CONTAINER_RUNTIME_BIN}' not found in PATH`);
  }

  if (issues.length > 0) {
    logger.error({ issues, gateway, bindHost, proxyPort }, 'Container networking self-check FAILED');
    return false;
  }

  logger.info(
    { gateway, bindHost, proxyPort },
    'Container networking self-check PASSED — gateway detected, proxy bound correctly',
  );
  return true;
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
