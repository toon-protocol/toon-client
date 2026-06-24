import { describe, it, expect } from 'vitest';
import { dataModelFromEvent, resolvePath, resolveValue } from './binding.js';
import { type NostrEvent } from '../types.js';

function evt(partial: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'id1',
    pubkey: 'pk1',
    created_at: 42,
    kind: 31337,
    tags: [['title', 'Hello'], ['t', 'topic']],
    content: 'the body',
    sig: 'sig',
    ...partial,
  };
}

describe('dataModelFromEvent', () => {
  it('projects the decoded event into the data-model root', () => {
    const model = dataModelFromEvent(evt());
    expect(model['content']).toBe('the body');
    expect(model['pubkey']).toBe('pk1');
    expect(model['kind']).toBe(31337);
    // tags exposed both raw and indexed by name (first value wins)
    expect((model['tag'] as Record<string, string>)['title']).toBe('Hello');
  });
});

describe('resolvePath', () => {
  it('resolves JSON-Pointer paths into the model', () => {
    const model = dataModelFromEvent(evt());
    expect(resolvePath(model, '/content')).toBe('the body');
    expect(resolvePath(model, '/tag/title')).toBe('Hello');
    expect(resolvePath(model, '/missing')).toBeUndefined();
    expect(resolvePath(model, '/tag/nope')).toBeUndefined();
  });
});

describe('resolveValue', () => {
  const model = dataModelFromEvent(evt());
  it('passes through literals', () => {
    expect(resolveValue('x', model)).toBe('x');
    expect(resolveValue(5, model)).toBe(5);
  });
  it('resolves { path } bindings', () => {
    expect(resolveValue({ path: '/content' }, model)).toBe('the body');
  });
  it('resolves v0.8 { literalString } form', () => {
    expect(resolveValue({ literalString: 'lit' }, model)).toBe('lit');
  });
});
