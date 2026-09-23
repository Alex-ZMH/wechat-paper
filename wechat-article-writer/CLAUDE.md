# Claude Code Instructions

Work only inside this bundle. Do not add public-account passwords, API keys, follower data, unpublished private materials, or production URLs.

Keep the agent thin and put the shared editorial method in
`skills/nonfiction-content-writing/SKILL.md`; channel and industrial rules remain optional skills. Validate the bundle before handoff:

```bash
node <agent-kit-root>/bin/matterai-bundle.mjs validate .
node <agent-kit-root>/bin/matterai-bundle.mjs eval .
```
