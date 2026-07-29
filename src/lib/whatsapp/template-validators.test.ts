import { describe, expect, it } from 'vitest';
import { extractVariableIndices } from './template-validators';

describe('extractVariableIndices', () => {
  it('returns sorted unique 1-based indices', () => {
    expect(extractVariableIndices('Hi {{2}} and {{1}} {{2}}')).toEqual([1, 2]);
  });
  it('returns empty array for no variables', () => {
    expect(extractVariableIndices('No vars here')).toEqual([]);
  });
});
