// Skill library (skill 文本层): methodology / pitfalls / reminders, coding-agent style.
// Skills are NOT callable and NOT tools; they are guidance retrieved on demand and injected
// into the prompt. Persisted as JSON.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillNote } from '@mc-agent/contracts';

export interface SkillLibraryJSON {
  skills: SkillNote[];
}

export interface SkillInput {
  name: string;
  description?: string;
  tags?: string[];
  text: string;
}

export class SkillLibrary {
  private readonly notes = new Map<string, SkillNote>();
  private readonly path?: string;

  constructor(opts: { skills?: SkillNote[]; path?: string } = {}) {
    for (const s of opts.skills ?? []) this.notes.set(s.name, s);
    if (opts.path) this.path = opts.path;
  }

  /** Create or replace a skill note (text). */
  write(input: SkillInput): SkillNote {
    const existing = this.notes.get(input.name);
    const at = new Date().toISOString();
    const note: SkillNote = {
      name: input.name,
      description: input.description ?? existing?.description ?? '',
      tags: input.tags ?? existing?.tags ?? [],
      text: input.text,
      created: existing?.created ?? at,
      updated: at,
    };
    this.notes.set(note.name, note);
    this.persist();
    return note;
  }

  get(name: string): SkillNote | undefined {
    return this.notes.get(name);
  }

  list(): SkillNote[] {
    return [...this.notes.values()];
  }

  /** On-demand retrieval: substring match over name/description/tags/text. */
  search(query?: string): SkillNote[] {
    if (!query) return this.list();
    const q = query.toLowerCase();
    return this.list().filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.description.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)) ||
        n.text.toLowerCase().includes(q),
    );
  }

  remove(name: string): boolean {
    const ok = this.notes.delete(name);
    if (ok) this.persist();
    return ok;
  }

  toJSON(): SkillLibraryJSON {
    return { skills: this.list() };
  }

  static fromJSON(data: SkillLibraryJSON): SkillLibrary {
    return new SkillLibrary({ skills: data.skills });
  }

  static load(path: string): SkillLibrary {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as SkillLibraryJSON;
      return new SkillLibrary({ skills: data.skills, path });
    } catch {
      return new SkillLibrary({ path });
    }
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.toJSON(), null, 2));
  }

  private persist(): void {
    if (this.path) this.save(this.path);
  }
}
