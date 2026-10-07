/**
 * @fileoverview Runs a tool through `runToolContract` and returns its error envelope.
 * @module tests/helpers/contract-error
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

/** The `structuredContent.error` a failed tool call carries on the wire. */
export interface ContractError {
  code: number;
  data: {
    reason?: string;
    recovery?: { hint: string };
    retryable?: boolean;
    [key: string]: unknown;
  };
  message: string;
}

type ToolDefinition = Parameters<typeof runToolContract>[0];

/**
 * Runs `definition` the way the production handler factory does and returns the error
 * envelope. A declared reason thrown without a hint comes back with the contract recovery
 * filled, which a direct `definition.handler(...)` call never applies.
 */
export async function contractError<D extends ToolDefinition>(
  definition: D,
  input: Parameters<typeof runToolContract<D>>[1],
): Promise<ContractError> {
  const result = await runToolContract(definition, input);
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ContractError }).error;
}
