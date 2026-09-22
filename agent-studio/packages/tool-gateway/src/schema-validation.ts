/**
 * schema-validation.ts — JSON Schema validation for tool args (step 1-2 of 10)
 * Source: agent_studio_architecture.md:486-506 (1 validate tool name, 2 validate args schema)
 * Uses Ajv-like validation but pure zod/JSON Schema; no external network.
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';

export interface ValidationResult {
  ok: true;
  data: unknown;
}

export type ValidationError = {
  ok: false;
  code: 'SCHEMA_VALIDATION_FAILED';
  message: string;
  details: unknown[];
};

export function validateToolName(
  toolName: string,
  registry: Map<string, ToolDescriptor> | { get(id: string): ToolDescriptor | undefined },
): { ok: true; descriptor: ToolDescriptor } | { ok: false; error: ValidationError } {
  const desc =
    (registry as Map<string, ToolDescriptor>).get(toolName) ??
    (registry as { get(id: string): ToolDescriptor | undefined }).get(toolName);
  if (!desc) {
    return {
      ok: false,
      error: {
        ok: false,
        code: 'SCHEMA_VALIDATION_FAILED',
        message: `unknown tool: ${toolName}`,
        details: [{ toolName }],
      },
    };
  }
  return { ok: true, descriptor: desc };
}

// Minimal JSON Schema validator — handles type, required, properties, minLength/maxLength, additionalProperties
export function validateArgs(args: unknown, schema: unknown): ValidationResult | ValidationError {
  const errors: unknown[] = [];
  if (typeof schema !== 'object' || schema === null) return { ok: true, data: args };

  const s = schema as Record<string, unknown>;
  const type = s['type'] as string | undefined;
  if (type === 'object') {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return {
        ok: false,
        code: 'SCHEMA_VALIDATION_FAILED',
        message: 'args must be object',
        details: [{ type }],
      };
    }
    const obj = args as Record<string, unknown>;
    const required = (s['required'] as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) errors.push({ key, message: `missing required property: ${key}` });
    }
    const props = (s['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      const val = obj[key];
      if (val === undefined) continue;
      const propType = propSchema['type'] as string | undefined;
      if (propType === 'string' && typeof val !== 'string')
        errors.push({ key, message: `expected string` });
      if (propType === 'string' && typeof val === 'string') {
        const minLength = propSchema['minLength'] as number | undefined;
        const maxLength = propSchema['maxLength'] as number | undefined;
        if (minLength !== undefined && val.length < minLength)
          errors.push({ key, message: `minLength ${minLength}` });
        if (maxLength !== undefined && val.length > maxLength)
          errors.push({ key, message: `maxLength ${maxLength}` });
      }
    }
    const additionalProperties = s['additionalProperties'];
    if (additionalProperties === false) {
      const allowed = new Set(Object.keys(props));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key))
          errors.push({ key, message: `additional property not allowed: ${key}` });
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: 'SCHEMA_VALIDATION_FAILED',
      message: `schema validation failed: ${errors.length} errors`,
      details: errors,
    };
  }
  return { ok: true, data: args };
}
