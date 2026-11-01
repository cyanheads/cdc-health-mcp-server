/**
 * @fileoverview The User-Agent every upstream request sends.
 * @module services/user-agent
 */

/**
 * Names this server to CDC's upstreams. Sent explicitly because a runtime's default client
 * string is not a stable identity: the CDN in front of CDC WONDER answers Node's default `fetch`
 * client with HTTP 403 "Access Denied" while it serves Bun's and curl's.
 */
export const USER_AGENT =
  'cdc-health-mcp-server (+https://github.com/cyanheads/cdc-health-mcp-server)';
