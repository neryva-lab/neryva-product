/**
 * registry.test.ts — read-only tool registry for definition validation
 * Source: agent_studio_implementation_plan.md:1354
 */

import { describe, it, expect } from 'vitest';
import { InMemoryToolRegistry, defaultRegistry } from '../src/registry.js';

describe('tool registry — read-only', () => {
  it('default registry contains search_tickets', () => {
    expect(defaultRegistry.has('search_tickets')).toBe(true);
    expect(defaultRegistry.get('search_tickets')?.effectClass).toBe('READ_ONLY');
  });

  it('create_ticket requires approval', () => {
    const desc = defaultRegistry.get('create_ticket');
    expect(desc?.approvalRequirement).toBe('REQUIRED');
    expect(desc?.effectClass).toBe('MUTATING');
  });

  it('unknown tool not in registry', () => {
    expect(defaultRegistry.has('unknown_tool')).toBe(false);
  });

  it('InMemoryToolRegistry list is stable', () => {
    const reg = new InMemoryToolRegistry();
    const list = reg.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((d) => d.toolId)).toContain('search_tickets');
  });
});
