# Brevyn Community

<p align="center">
  <a href="https://github.com/KOIAI777/brevyn/stargazers">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/KOIAI777/brevyn?style=social">
  </a>
</p>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

Brevyn Community is the open-source, local-first Brevyn desktop workspace. It combines course materials, tasks, Office/PDF preview, retrieval, conversations, and agent workflows in one semester-based workspace. Model access is configured through user-owned BYOK providers.

![Brevyn workspace](./resources/readme/brevyn-window.png)

## Features

- Semester and course workspaces: organize courses, materials, assignments, and conversations by semester.
- Task-based conversations: keep separate sessions for essays, presentations, projects, exams, and other assignments.
- Course file management: import, preview, open, rename, delete, and re-index course files.
- File preview: preview PDFs, Word documents, PowerPoint decks, spreadsheets, images, and common text files.
- Parsing and embedding pipeline: parse PDFs, PPTX, DOCX, text, and code files locally; scanned pages, screenshots, and image-based materials can use OCR / MinerU before chunking, embedding, and indexing.
- Course material retrieval: index course files and retrieve relevant snippets inside conversations.
- Add references to chat: select text from file previews and add it to the current conversation as context.
- Multimodal input: preview image attachments and configure vision models.
- Agent conversations: run AI workflows powered by Claude Agent SDK.
- Conversation forking: fork a conversation from a previous message and continue exploring from that point.
- Workspace memory: configure long-term memory at semester, course, and task levels.
- Skill system: use built-in skills for writing, research, document processing, academic workflows, and more.
- MCP settings: manage MCP server configuration inside the app.
- BYOK providers: configure Agent, Embedding, Vision, and OCR providers.
- Independent updates: Community builds only read releases from the public Community repository.

## Typical Workflow

1. Create or select a semester.
2. Add courses and import course materials.
3. Create assignment tasks such as essays, presentations, or projects.
4. Start a conversation under a task and let Brevyn retrieve course materials for analysis, writing, or planning.
5. Select important snippets from file previews and add them to the current conversation.
6. Use skills, MCP, memory, and conversation forking to handle more complex workflows.

## Built-In Capabilities

### Courses and Tasks

Brevyn uses semesters as the top-level workspace. Each semester can contain multiple courses, and each course can contain multiple assignment tasks. When tasks are connected to conversations, files, context, and discussion stay organized around the assignment.

### Files and References

Course files can be imported into course-level or task-level sections. Brevyn makes those files searchable and provides course-material references inside conversations. Users can also manually select snippets from previews and add them to the current conversation.

### Parsing, OCR, and Embedding Pipeline

Course materials first go through Brevyn's parsing pipeline. Text files are extracted directly; PDFs, PPTX, DOCX, and similar documents are split into retrieval-ready snippets; scanned pages, screenshots, and image-based materials can use OCR / MinerU to turn page content into searchable text.

Parsed content is queued for indexing, chunked by course and task scope, embedded, and written into vector and text retrieval indexes. When materials change, they can be re-indexed so the agent can retrieve evidence from the current course or assignment scope.

![File panel and chat context](./resources/readme/actual-workspace-files.png)

![Source scope and indexing status](./resources/readme/actual-workspace-sources.png)

### Agent and Skills

Brevyn uses agent conversations for complex study tasks. Built-in skills can help with paper reading, academic writing, literature workflows, slide generation, data processing, and other learning scenarios.

### Built-in Skills and Credits

Brevyn includes built-in skills for document handling, slides, spreadsheets, PDFs, and academic research workflows. The slide-generation workflow is integrated from [ppt-master](https://github.com/hugohe3/ppt-master). Thanks to [@hugohe3](https://github.com/hugohe3) and the project contributors for the open-source workflow. The original license file is kept at [default-skills/ppt-master/LICENSE](./default-skills/ppt-master/LICENSE).

### Memory and Context

Brevyn supports memory settings across different workspace scopes. Stable preferences, project rules, writing requirements, and repeated workflows can be kept in workspace memory so future conversations stay consistent.

### Community and Official

This repository does not contain Brevyn Official account, billing, wallet, subscription, redeem-code, or official model provisioning logic. Community and Official use separate app IDs, installers, and update feeds.

## Development

Install dependencies:

```bash
npm install
```

Start development:

```bash
npm run dev
```

Type check:

```bash
npm run typecheck
```

Run the full pre-release verification suite (types, Skills, Python, tests, and build):

```bash
npm run verify
```

Build:

```bash
npm run build
```

Package for macOS:

```bash
npm run dist:mac
```

## Documentation

- [Architecture](docs/architecture.md)
- [Claude Agent SDK setup](docs/agent-sdk-setup.md)
- [OpenAI Responses Anthropic adapter](docs/openai-responses-anthropic-adapter.md)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=KOIAI777/brevyn&type=Date)](https://www.star-history.com/#KOIAI777/brevyn&Date)

## Status

Brevyn Community is currently in an early release stage. Features, UI, and built-in workflows are still evolving quickly.
