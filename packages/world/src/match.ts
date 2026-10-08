// Official tag / block matching (framework §5): match by block id or official tag.
// Never a hand-made block taxonomy.

import type { Match, TagTable } from '@mc-agent/contracts';

export function makeBlockMatcher(match: Match, tags?: TagTable): (block: string) => boolean {
  switch (match.kind) {
    case 'any':
      return () => true;
    case 'block':
      return (b) => b === match.block;
    case 'tag': {
      const set = new Set(tags?.blocks[match.tag] ?? []);
      return (b) => set.has(b);
    }
  }
}

export function makeEntityMatcher(match: Match, tags?: TagTable): (type: string) => boolean {
  switch (match.kind) {
    case 'any':
      return () => true;
    case 'block':
      return (t) => t === match.block;
    case 'tag': {
      const set = new Set(tags?.entities[match.tag] ?? []);
      return (t) => set.has(t);
    }
  }
}
