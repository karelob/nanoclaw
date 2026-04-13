/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Dual OAuth token support (Šiška):
 *   Evolution Enterprise token is the primary key.
 *   Personal Max token is the fallback when Evolution is exhausted.
 *   State (which token is active) persists in ~/.config/nanoclaw/token_state.json.
 *   When the OAuth exchange fails with a usage/rate limit error, the proxy
 *   immediately retries with the fallback token and updates state so subsequent
 *   containers use the correct token without another round-trip failure.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  getTokenStateSummary,
  markEvolutionFailed,
  markEvolutionOk,
  parseRetryAfterMs,
  shouldUseEvolution,
} from './token-state.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_OAUTH_EVOLUTION',
  ]);

  // Dual OAuth token support: Evolution = primary, personal Max = fallback.
  // Only active when CLAUDE_OAUTH_EVOLUTION is set alongside a personal token.
  const evolutionToken = secrets.CLAUDE_OAUTH_EVOLUTION;
  const personalToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const dualTokenMode = !!(evolutionToken && personalToken);

  // OAuth token takes precedence — API key is fallback only
  const authMode: AuthMode =
    personalToken || evolutionToken
      ? 'oauth'
      : secrets.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  /**
   * Perform a single upstream request, returning status code, headers, and
   * buffered body.  Used for OAuth exchange requests where we need to inspect
   * the response before forwarding it (to detect usage-limit failures and
   * retry with the fallback token).
   */
  function bufferedUpstreamRequest(
    headers: Record<string, string | number | string[] | undefined>,
    body: Buffer,
    reqUrl: string | undefined,
    method: string | undefined,
  ): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const upstream = makeRequest(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isHttps ? 443 : 80),
          path: reqUrl,
          method: method || 'POST',
          headers,
        } as RequestOptions,
        (upRes) => {
          const chunks: Buffer[] = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            resolve({
              statusCode: upRes.statusCode ?? 502,
              headers: upRes.headers as Record<
                string,
                string | string[] | undefined
              >,
              body: Buffer.concat(chunks),
            });
          });
          upRes.on('error', reject);
        },
      );
      upstream.on('error', reject);
      upstream.write(body);
      upstream.end();
    });
  }

  /**
   * Return true if an upstream response from an OAuth exchange indicates a
   * usage/rate limit error that warrants switching to the fallback token.
   */
  function isUsageLimitError(statusCode: number, body: Buffer): boolean {
    if (statusCode === 429 || statusCode === 402) return true;
    if (statusCode < 400) return false;
    // Check response body for known usage-limit patterns
    const text = body.toString('utf-8');
    return (
      text.includes('usage_limit') ||
      text.includes('rate_limit') ||
      text.includes('Claude Max') ||
      text.includes('usage limit') ||
      text.includes('quota')
    );
  }

  return new Promise((resolve, reject) => {
    logger.info(
      {
        dualTokenMode,
        activeToken: dualTokenMode ? getTokenStateSummary() : 'single-token',
      },
      'Credential proxy starting',
    );

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;

          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );
          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
          upstream.write(body);
          upstream.end();
          return;
        }

        // OAuth mode
        if (!headers['authorization']) {
          // Post-exchange request carrying a temp x-api-key — pass through.
          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );
          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
          upstream.write(body);
          upstream.end();
          return;
        }

        // OAuth exchange request (has Authorization header).
        // In dual-token mode: try Evolution first; on usage-limit failure,
        // retry with personal Max token and update state.
        const handleOAuthExchange = async () => {
          const tryWithToken = (token: string) => {
            const h = { ...headers };
            delete h['authorization'];
            h['authorization'] = `Bearer ${token}`;
            return bufferedUpstreamRequest(h, body, req.url, req.method);
          };

          if (!dualTokenMode) {
            // Single-token mode — classic behaviour
            delete headers['authorization'];
            if (personalToken || evolutionToken) {
              headers['authorization'] =
                `Bearer ${personalToken || evolutionToken}`;
            }
            const upstream = makeRequest(
              {
                hostname: upstreamUrl.hostname,
                port: upstreamUrl.port || (isHttps ? 443 : 80),
                path: req.url,
                method: req.method,
                headers,
              } as RequestOptions,
              (upRes) => {
                res.writeHead(upRes.statusCode!, upRes.headers);
                upRes.pipe(res);
              },
            );
            upstream.on('error', (err) => {
              logger.error(
                { err, url: req.url },
                'Credential proxy upstream error',
              );
              if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
              }
            });
            upstream.write(body);
            upstream.end();
            return;
          }

          // Dual-token mode
          const useEvolution = shouldUseEvolution();
          const primaryToken = useEvolution ? evolutionToken! : personalToken!;

          let result = await tryWithToken(primaryToken).catch((err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            return null;
          });

          if (!result) {
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
            return;
          }

          if (result.statusCode < 400) {
            // Success on primary token
            if (useEvolution) {
              markEvolutionOk();
            }
            res.writeHead(result.statusCode, result.headers);
            res.end(result.body);
            return;
          }

          // Primary token failed
          if (
            useEvolution &&
            isUsageLimitError(result.statusCode, result.body)
          ) {
            // Evolution exhausted — try personal Max
            const retryAfterHeader = result.headers['retry-after'] as
              | string
              | undefined;
            markEvolutionFailed(
              `HTTP ${result.statusCode}`,
              parseRetryAfterMs(retryAfterHeader),
            );

            logger.info(
              { statusCode: result.statusCode, url: req.url },
              'Evolution token exhausted — retrying with personal Max token',
            );

            const fallbackResult = await tryWithToken(personalToken!).catch(
              (err) => {
                logger.error({ err }, 'Personal fallback request error');
                return null;
              },
            );

            if (!fallbackResult) {
              if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
              }
              return;
            }

            res.writeHead(fallbackResult.statusCode, fallbackResult.headers);
            res.end(fallbackResult.body);
            return;
          }

          // Non-usage-limit error or already on personal — forward as-is
          res.writeHead(result.statusCode, result.headers);
          res.end(result.body);
        };

        handleOAuthExchange().catch((err) => {
          logger.error({ err, url: req.url }, 'OAuth exchange handler error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_OAUTH_EVOLUTION',
  ]);
  // OAuth token takes precedence — matches startCredentialProxy() logic
  return secrets.CLAUDE_CODE_OAUTH_TOKEN ||
    secrets.ANTHROPIC_AUTH_TOKEN ||
    secrets.CLAUDE_OAUTH_EVOLUTION
    ? 'oauth'
    : secrets.ANTHROPIC_API_KEY
      ? 'api-key'
      : 'oauth';
}
