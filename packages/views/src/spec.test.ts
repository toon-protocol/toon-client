import { describe, it, expect } from 'vitest';
import { validateViewSpec, type ViewSpec } from './spec.js';
import { buildFeedFilter } from './filters.js';

const ATOMS = ['stack', 'note-card', 'profile-header', 'generic-event'];
const TOOLS = ['toon_publish_unsigned', 'toon_upload_media'];

function validate(input: unknown) {
  return validateViewSpec(input, { allowedAtoms: ATOMS, allowedTools: TOOLS });
}

describe('validateViewSpec', () => {
  it('accepts a well-formed composed spec', () => {
    const spec: ViewSpec = {
      title: 'Feed',
      root: {
        atom: 'stack',
        children: [
          { atom: 'note-card', bind: { query: buildFeedFilter(), kindAuto: true } },
          {
            atom: 'note-card',
            actions: {
              reply: { tool: 'toon_publish_unsigned', args: { kind: 1 }, spendy: false },
            },
          },
        ],
      },
    };
    const res = validate(spec);
    expect(res.ok).toBe(true);
  });

  it('rejects a non-object spec and a missing root', () => {
    expect(validate(null).ok).toBe(false);
    expect(validate({ title: 'x' }).ok).toBe(false);
  });

  it('rejects unknown atom ids and lists valid atoms', () => {
    const res = validate({ root: { atom: 'evil-atom' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const msg = res.errors.join('\n');
      expect(msg).toContain('unknown atom "evil-atom"');
      expect(msg).toContain('Valid atoms:');
      expect(msg).toContain('See toon_atoms for full vocabulary');
      // every allowed atom should appear in the list
      for (const id of ATOMS) expect(msg).toContain(id);
    }
  });

  it('suggests a near-miss atom via edit distance', () => {
    // 'stak' is 1 edit away from 'stack'
    const res = validate({ root: { atom: 'stak' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toContain('Did you mean "stack"');
  });

  it('omits suggestion when no atom is close enough', () => {
    // 'text' has edit distance > floor(4/2)=2 from all test atoms
    const res = validate({ root: { atom: 'text' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).not.toContain('Did you mean');
  });

  it('omits suggestion for atom names longer than 64 chars (DoS guard)', () => {
    const longName = 'A'.repeat(65);
    const res = validate({ root: { atom: longName } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).not.toContain('Did you mean');
  });

  it('rejects disallowed write tools', () => {
    const res = validate({
      root: { atom: 'note-card', actions: { x: { tool: 'rm_rf_everything' } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('not allowed');
  });

  it('rejects unsupported filter keys and bad value types', () => {
    const res = validate({
      root: { atom: 'note-card', bind: { query: { kinds: 'nope', evil: [1] } } },
    });
    expect(res.ok).toBe(false);
  });

  it('enforces the max node count', () => {
    const children = Array.from({ length: 10 }, () => ({ atom: 'note-card' }));
    const res = validateViewSpec(
      { root: { atom: 'stack', children } },
      { allowedAtoms: ATOMS, maxNodes: 5 }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('max node count');
  });

  it('enforces the max depth', () => {
    let node: Record<string, unknown> = { atom: 'note-card' };
    for (let i = 0; i < 6; i++) node = { atom: 'stack', children: [node] };
    const res = validateViewSpec({ root: node }, { allowedAtoms: ATOMS, maxDepth: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('max depth');
  });

  it('rejects non-JSON-serializable props', () => {
    const props: Record<string, unknown> = {};
    props['fn'] = () => 1;
    const res = validate({ root: { atom: 'note-card', props } });
    expect(res.ok).toBe(false);
  });

  it('rejects a non-string confirmLabel', () => {
    const res = validate({
      root: {
        atom: 'note-card',
        actions: { x: { tool: 'toon_publish_unsigned', spendy: true, confirmLabel: 42 } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('confirmLabel: must be a string');
  });
});
