---
name: skill-creator
description: Guides authoring new Claude Code skills — scaffolding the directory, writing valid SKILL.md frontmatter, and following naming/structure best practices. Use when the user wants to create, design, or refine a skill (slash-command capability) for this repository.
---

# Skill Creator

Helps you author a new **skill** for Claude Code: a reusable capability packaged
as a `SKILL.md` (plus optional supporting files) under `.claude/skills/`.

## What a skill is

A skill is a directory under `.claude/skills/<skill-name>/` containing a
`SKILL.md` file. Claude loads the skill's `name` + `description` so it knows
*when* to invoke it; the body is read *on demand* when the skill runs. Skills
are how you teach Claude a repeatable workflow without bloating the main prompt.

```
.claude/
└── skills/
    └── my-skill/
        ├── SKILL.md          # required: frontmatter + instructions
        ├── reference.md      # optional: deeper docs loaded only when needed
        └── scripts/          # optional: helper scripts the skill calls
```

## How to create a skill

1. **Pick a name.** Lowercase, hyphen-separated, verb-or-noun phrase that reads
   like a command (`deploy-check`, `transcribe-debug`, `release-notes`). This
   becomes the directory name and the `/`-invocable slash command.
2. **Scaffold the directory:** `.claude/skills/<name>/SKILL.md`.
3. **Write the frontmatter** (YAML, between `---` fences):
   - `name`: must match the directory name.
   - `description`: third person, one or two sentences. State *what it does*
     **and** *when to use it* — this is the only thing Claude sees when deciding
     whether to trigger the skill, so make the trigger conditions explicit.
4. **Write the body** as clear, imperative instructions: the steps, the
   commands to run, the files to touch, the gotchas to avoid. Keep the always-on
   part small; push long reference material into separate files the body points
   to ("see `reference.md`").
5. **Verify**: the file parses as valid YAML frontmatter + markdown, the `name`
   matches the folder, and the description's trigger is unambiguous.

## Writing a good `description`

The description is the trigger. Bad descriptions never fire or fire too often.

- ✅ `Generates structured release notes from merged PRs since the last tag. Use when the user asks to draft a changelog or release notes.`
- ❌ `Release notes helper.` (no trigger, too vague)
- ❌ `Use this for everything about releases.` (over-broad, will mis-fire)

Lead with the action, then the explicit "Use when…" condition. Write in third
person about Claude/the skill, not "I" or "you".

## Body best practices

- **Be concrete:** name actual files, commands, and flags from *this* repo.
- **Front-load the common path;** put edge cases and deep references later or in
  linked files.
- **Encode the repo's hard rules** (see this project's `CLAUDE.md`) so the skill
  never violates them.
- **Keep it short enough to stay useful** — a skill is guidance, not an essay.

## Minimal template

```markdown
---
name: example-skill
description: One-line statement of what it does. Use when <explicit trigger>.
---

# Example Skill

Brief purpose.

## Steps
1. …
2. …

## Gotchas
- …
```

## Notes for this environment

In the **local Claude Code CLI**, skills can also ship via plugins
(`/plugin install …`, `/reload-plugins`). In **web/remote sessions** the
`/plugin` command is unavailable, so author skills directly as committed files
under `.claude/skills/` — which is what this skill helps you do. Skills
committed to the repo are available to anyone who opens it in Claude Code.
