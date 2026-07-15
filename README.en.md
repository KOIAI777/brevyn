# Brevyn Community

<p align="center">
  <a href="https://github.com/KOIAI777/brevyn/stargazers">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/KOIAI777/brevyn?style=social">
  </a>
  <a href="https://github.com/KOIAI777/brevyn/releases/latest">
    <img alt="Latest Community release" src="https://img.shields.io/github/v/release/KOIAI777/brevyn?label=Community">
  </a>
  <a href="./LICENSE">
    <img alt="AGPL-3.0 license" src="https://img.shields.io/badge/license-AGPL--3.0-blue">
  </a>
</p>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

Brevyn Community is the open-source, local-first Brevyn desktop workspace. It keeps course materials, tasks, Office/PDF previews, retrieval, citations, conversations, and agent workflows inside one semester-based workspace. Model access is configured through user-owned BYOK providers.

<p align="center">
  <a href="https://www.brevyn.org/">Website</a> ·
  <a href="https://www.brevyn.org/#download">All downloads</a> ·
  <a href="https://github.com/KOIAI777/brevyn/releases/latest">Community release</a> ·
  <a href="./CONTRIBUTING.md">Contribute</a>
</p>

![Brevyn workspace](./resources/readme/brevyn-window.png)

## From Materials to Verifiable Answers

Brevyn retrieves indexed materials within the current course and assignment scope. Sources can open the corresponding file, page, slide, or content region so an answer can be checked against the original material instead of ending at a detached summary.

![Retrieval results and source location](./resources/readme/rag-evidence.png)

## Read and Cite in One Workspace

### Organize materials by course

The file tree organizes materials by course, week, and assignment. Previews stay beside the conversation, preserving study context while files change.

![Course file tree and preview](./resources/readme/course-files.png)

### Ask from selected source content

Select a paragraph or content region in the preview and send it to the current conversation as explicit context without repeatedly explaining the file, page, or location.

![Select a source and ask Brevyn](./resources/readme/source-selection.png)

### Preview Office and PDF files

Built-in previews cover PDF, DOCX, PPTX, XLSX, images, and common text files. Spreadsheet previews preserve worksheets, cell selection, formula details, and common charts for follow-up analysis and citation.

![Spreadsheet and chart preview](./resources/readme/spreadsheet-preview.png)

## Core Capabilities

- **Course and assignment workspaces**: organize courses, shared materials, assignments, and ongoing conversations by semester.
- **Parsing and indexing**: parse PDF, PPTX, DOCX, XLSX, text, and code files; scanned or image-based material can use OCR / MinerU.
- **Retrieval and source navigation**: write parsed content to vector and text indexes, then return from results to the original file location.
- **Preview and citation**: select preview content, add it to a conversation, and switch between multiple material tabs.
- **Agent, Skills, and MCP**: extend complex workflows with tool calls, built-in study Skills, workspace memory, and MCP.
- **Local-first and BYOK**: configure Agent, Embedding, Vision, and OCR providers; Community uses its own data directory and public update feed.

## Editions and Downloads

| Edition | Best for | Models and services | Get it |
| --- | --- | --- | --- |
| Brevyn Community | Reviewing the source, building locally, configuring BYOK providers, or contributing | Bring your own Agent, Embedding, Vision, and OCR providers | [Community release](https://github.com/KOIAI777/brevyn/releases/latest) |
| Brevyn Official | A ready-to-install build with official accounts, model services, and automatic updates | Supports Brevyn services and third-party providers | [Download from the website](https://www.brevyn.org/#download) |

The editions use separate app IDs, data directories, and update feeds, so they can be installed side by side. This repository does not contain Official account, billing, wallet, subscription, redeem-code, or official model-provisioning logic.

### Community Platform Support

| Platform | Architecture | Package | Notes |
| --- | --- | --- | --- |
| macOS | Apple Silicon (arm64) | DMG / ZIP | Intel Macs are not currently supported |
| Windows | x64 | Setup EXE | The Windows build is currently unsigned and may trigger SmartScreen on first launch |

If GitHub downloads are slow, use the Community accelerated download on the [Brevyn website](https://www.brevyn.org/#download). Release files and version notes remain available from [GitHub Releases](https://github.com/KOIAI777/brevyn/releases).

## Community and Contact

- WeChat: `Rouget77`. Add the contact and include `GitHub` in your request to receive an invitation to the Brevyn community group.
- Bugs and feature requests: [GitHub Issues](https://github.com/KOIAI777/brevyn/issues)
- Security reports: use [GitHub Private Vulnerability Reporting](https://github.com/KOIAI777/brevyn/security/advisories/new). Do not post credentials, account details, or private materials in public issues.

<a href="./resources/readme/wechat-contact.jpg"><img src="./resources/readme/wechat-contact.jpg" alt="Add Brevyn on WeChat: Rouget77" width="260"></a>

## Open-Source Direction

### Next

- Extract deadlines, formatting rules, restrictions, and scoring dimensions from assignment briefs and rubrics, with checklists linked back to the source.
- Strengthen multi-source reading, cross-checking, comparison, and citation workflows for study and lightweight research.
- Continue improving PDF and Office previews, text selection, source highlighting, and navigation accuracy.
- Extend spreadsheet formulas, chart objects, and data-analysis workflows so XLSX files are not only viewable but consistently understandable to the agent.

### Contribution Areas

- LaTeX, references, and research-writing workflows.
- Dataset analysis, statistics, and reproducible reports.
- File parsing, the Office object model, preview compatibility, and cross-platform packaging.
- Reusable study Skills, MCP services, and specialist-tool integrations.

> This roadmap describes the current maintenance direction, not committed dates or delivery promises. Please open an Issue to discuss scope and implementation boundaries before starting a large change.

## Local Development

Requirements:

- Node.js 22 or newer
- Python 3.9 or newer
- Git
- LibreOffice is optional for basic development, but a runtime is required to build or verify high-fidelity Office previews

```bash
npm ci
npm run dev
```

Common checks and build commands:

```bash
npm run typecheck
npm run verify
npm run build
npm run dist:mac
```

## Contributing and Documentation

- [Contributing](CONTRIBUTING.md)
- [Contributor License Agreement](CLA.md)
- [Support](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Community and Official maintenance boundary](docs/edition-maintenance.md)
- [Architecture](docs/architecture.md)
- [Claude Agent SDK setup](docs/agent-sdk-setup.md)
- [OpenAI Responses Anthropic adapter](docs/openai-responses-anthropic-adapter.md)
- [ppt-master](https://github.com/hugohe3/ppt-master) provides the foundation for the built-in slide-generation workflow; its original license is kept at [default-skills/ppt-master/LICENSE](./default-skills/ppt-master/LICENSE)

## Star History

<a href="https://www.star-history.com/?repos=KOIAI777%2Fbrevyn&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=KOIAI777/brevyn&type=date&theme=dark&legend=top-left&sealed_token=TIGcFm1zpKrJWXBtEIYTqBP88gIyFhelK1hm1MY-1D6qv9Bd0r0MGQv_t9B7h3FBM6xIKmyqmRbPgbGjxbK-ILhjPSY8EikOOBldd11Aq6LR73xScgmEo9y9RP37wG_SpFjBN880w3y7lUSIZmRwVrEIpKaBmIpuMoOPsnnCMri4qfCUrAHwA4TXwLe1" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=KOIAI777/brevyn&type=date&legend=top-left&sealed_token=TIGcFm1zpKrJWXBtEIYTqBP88gIyFhelK1hm1MY-1D6qv9Bd0r0MGQv_t9B7h3FBM6xIKmyqmRbPgbGjxbK-ILhjPSY8EikOOBldd11Aq6LR73xScgmEo9y9RP37wG_SpFjBN880w3y7lUSIZmRwVrEIpKaBmIpuMoOPsnnCMri4qfCUrAHwA4TXwLe1" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=KOIAI777/brevyn&type=date&legend=top-left&sealed_token=TIGcFm1zpKrJWXBtEIYTqBP88gIyFhelK1hm1MY-1D6qv9Bd0r0MGQv_t9B7h3FBM6xIKmyqmRbPgbGjxbK-ILhjPSY8EikOOBldd11Aq6LR73xScgmEo9y9RP37wG_SpFjBN880w3y7lUSIZmRwVrEIpKaBmIpuMoOPsnnCMri4qfCUrAHwA4TXwLe1" />
 </picture>
</a>

## Status

Brevyn Community is still in an early release stage. Features, UI, and built-in workflows will continue to evolve. Review the release notes and known limitations before installing.
