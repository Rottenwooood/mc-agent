// Skills (文本层): textual methodology / pitfalls / reminders, in the coding-agent style.
// A skill is NOT callable and is NOT a tool; it is guidance retrieved on demand and injected
// into the prompt. Secondary actions are the callable, versioned compositions.

export interface SkillNote {
  name: string;
  description: string;
  tags: string[];
  /** The methodology / pitfalls / reminders text. */
  text: string;
  created: string;
  updated: string;
}
