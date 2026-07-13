# Contributing to Brevyn Community

Thanks for contributing to Brevyn Community. This repository contains the open-source, BYOK edition. It does not contain Brevyn Official account, billing, hosted model provisioning, or commercial release infrastructure.

## Before You Start

- Search existing issues before opening a new one.
- Use an issue for substantial features or architecture changes before implementation.
- Do not include credentials, private course materials, user data, or Brevyn Official service code.
- Read and accept [CLA.md](CLA.md) before submitting your first pull request.

## Development

Requirements:

- Node.js 22 or newer
- Python 3.9 or newer
- Git
- LibreOffice runtime when working on high-fidelity Office preview behavior

```bash
npm ci
npm run dev
```

Community data is isolated from Brevyn Official:

```text
~/.brevyn-community-dev/
~/Library/Application Support/Brevyn Community Dev/  # macOS
```

## Pull Requests

1. Create a focused branch from `main`.
2. Keep changes scoped and avoid unrelated formatting churn.
3. Add or update tests for behavioral changes.
4. Run `npm run verify` before requesting review.
5. Include screenshots for visible UI changes.
6. Complete every applicable item in the pull request template.

Default Skill content is version locked. When changing a bundled Skill, raise that Skill's version and run:

```bash
npm run update:skill-lock
```

## Community to Official

Community contributions are reviewed in this public repository first. Accepted changes may also be incorporated into Brevyn Official under the permissions granted by the CLA. Commercial-only code is maintained separately and must not be submitted here.

