import { describe, it, expect, vi } from 'vitest';
import { ControlApiError } from '../control-client.js';
import type { ControlClient } from '../control-client.js';
import type { ViewSpec } from '@toon-protocol/views';
import { runJourney } from './runner.js';
import type { JourneyPlan, JourneyStep } from './types.js';

function stubClient(impl: Partial<Record<keyof ControlClient, unknown>>): ControlClient {
  return impl as unknown as ControlClient;
}

const simpleSpec: ViewSpec = { root: { atom: 'stack' } };

function makeStep(id: string, toolName: string, overrides: Partial<JourneyStep> = {}): JourneyStep {
  return {
    id,
    toolName,
    buildInput: () => ({}),
    renderPanel: () => simpleSpec,
    ...overrides,
  };
}

describe('runJourney', () => {
  it('empty plan completes with no steps', async () => {
    const plan: JourneyPlan = { id: 'p', title: 'Empty', steps: [] };
    const result = await runJourney(plan, stubClient({}));
    expect(result.completed).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('advances through all steps and threads state forward', async () => {
    const status = vi
      .fn()
      .mockResolvedValue({ ready: true, bootstrapping: false });
    const client = stubClient({ status });
    const seenState: unknown[] = [];

    const plan: JourneyPlan = {
      id: 'p',
      title: 'Thread test',
      steps: [
        makeStep('s1', 'toon_status'),
        makeStep('s2', 'toon_status', {
          buildInput: (state) => {
            seenState.push({ ...state });
            return {};
          },
        }),
      ],
    };

    const result = await runJourney(plan, client);
    expect(result.completed).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.error).toBeUndefined();
    // s2's buildInput received s1's result in state
    expect(seenState[0]).toHaveProperty('s1');
  });

  it('each step panel carries structuredContent.viewSpec', async () => {
    const status = vi.fn().mockResolvedValue({ ready: true });
    const spec: ViewSpec = { title: 'My panel', root: { atom: 'stack' } };

    const plan: JourneyPlan = {
      id: 'p',
      title: 'Panel test',
      steps: [makeStep('s1', 'toon_status', { renderPanel: () => spec })],
    };

    const result = await runJourney(plan, stubClient({ status }));
    expect(result.steps[0]!.panel.structuredContent?.['viewSpec']).toEqual(spec);
    expect(result.steps[0]!.panel.content[0]!.type).toBe('text');
  });

  it('halts on tool error and returns partial result with the error', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ ready: true })
      .mockRejectedValueOnce(new ControlApiError('boom', 500, false, 'detail'));
    const client = stubClient({ status });

    const plan: JourneyPlan = {
      id: 'p',
      title: 'Error test',
      steps: [makeStep('s1', 'toon_status'), makeStep('s2', 'toon_status')],
    };

    const result = await runJourney(plan, client);
    expect(result.completed).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.error?.stepId).toBe('s2');
    expect(result.error?.message).toMatch(/boom/);
  });

  it('halts on first step error with no completed steps', async () => {
    const status = vi
      .fn()
      .mockRejectedValue(new ControlApiError('nope', 503, true));
    const client = stubClient({ status });

    const plan: JourneyPlan = {
      id: 'p',
      title: 'First step error',
      steps: [makeStep('s1', 'toon_status'), makeStep('s2', 'toon_status')],
    };

    const result = await runJourney(plan, client);
    expect(result.completed).toBe(false);
    expect(result.steps).toHaveLength(0);
    expect(result.error?.stepId).toBe('s1');
  });
});
