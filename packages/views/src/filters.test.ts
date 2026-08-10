import { describe, it, expect } from 'vitest';
import { buildPRListFilter, buildPRUpdateFilter } from './filters.js';

describe('NIP-34 PR filters (#446)', () => {
  it('buildPRListFilter requests both patch (1617) and pull-request (1618) kinds', () => {
    const filter = buildPRListFilter('owner', 'repo');
    expect(filter.kinds).toEqual([1617, 1618]);
    expect(filter['#a']).toEqual(['30617:owner:repo']);
  });

  it('buildPRUpdateFilter keys kind:1619 on the uppercase #E tag', () => {
    const filter = buildPRUpdateFilter(['pr1', 'pr2']);
    expect(filter.kinds).toEqual([1619]);
    expect(filter['#E']).toEqual(['pr1', 'pr2']);
    expect(filter.limit).toBe(500);
  });
});
