---
name: learning-evidence-reader
description: "Use this skill for Brevyn learning-material tasks that require evidence from course files, assignment briefs, rubrics, lecture slides, PDFs, DOCX/PPTX/XLSX/CSV files, research papers, collected sources, citations, revision materials, or report/PPT source reuse. Trigger when the user asks what a source says, whether a topic appears in materials, where evidence is located, how to summarize or compare learning sources, how to verify assignment rules/deadlines/penalties, how to read multiple papers for a literature review, or how to reuse figures/tables/results from existing materials."
license: Proprietary. LICENSE.txt has complete terms
version: "0.2.0"
category: learning
tags:
  - learning
  - evidence
  - rag
  - course
  - research
  - citations
---

# Learning Evidence Reader

## Purpose

Use this skill when the answer must be grounded in Brevyn learning materials: course files, assignment documents, lecture slides, readings, PDFs, Office files, spreadsheets, research papers, reports, or collected sources.

This skill is not a generic RAG shortcut. It is a reading workflow for learning and micro-research tasks.

## Core Principle

RAG locates candidate files. Full parsed-source reading verifies final claims.

Do not treat a RAG chunk as complete proof for high-risk or complete-answer tasks. Use RAG to narrow the field, then read the relevant source files. For a small number of candidate learning sources, default to `read_parsed_file` and read the complete parsed Markdown before finalizing. This parsed Markdown is the same source text Brevyn chunks for indexing, so it is the right readable surface for full-document verification. Use structured artifacts and semantic units to verify tables, charts, formulas, speaker notes, images, page/slide/range anchors, and exact citations.

## Workflow Router

Choose the smallest workflow that satisfies the user request.

### 1. Specific File Mode

Use when the user names, attaches, or clearly points to one file.

1. Resolve the file with `list_course_files` or `get_file_record`.
2. If parsed Markdown is available, call `read_parsed_file` and read the complete file. Follow `nextOffset` until `truncated=false` unless the user asked for only a narrow excerpt.
3. Use the matching reader/skill or structured artifact when the answer depends on layout or objects:
   - DOCX: tables, comments, footnotes/endnotes, tracked changes, figures/captions.
   - PPTX: speaker notes, slide numbers, charts, images, hidden slides, theme/layout.
   - XLSX/CSV/TSV: formulas, charts, sheet/range anchors, tables, comments, hidden sheets.
   - PDF: page anchors, OCR/scanned pages, figures/tables, layout-sensitive evidence.
4. Use RAG only if the user asks for cross-file comparison or related-source discovery.
5. Cite filename and location when available: page, slide, sheet/range, section, or heading.

### 2. Course Evidence Mode

Use for course concepts, assignment requirements, rubrics, deadlines, late penalties, allowed/disallowed materials, academic integrity rules, exam/revision materials, or learning checklists.

1. If scope is unclear, call `course_structure` and `list_course_files`.
2. Filter cheaply by metadata first: filename, file type, week, task, folder/category, and indexing status.
3. Use `rag_search` to locate candidate files and positions.
4. For complete requirements, grading standards, rubrics, or checklists, do not rely on one query. Plan several query wordings from:
   - the user's wording,
   - filenames,
   - early RAG results,
   - likely source vocabulary,
   - visible course terms.
5. Read the top 1-3 key source files before finalizing. If parsed Markdown is available, read each complete parsed file with `read_parsed_file` rather than relying on the returned RAG chunks. Expand to top 5 only when results are incomplete, conflicting, or the user asks for broader coverage.
6. For high-risk course rules, final answers must be verified by source reading: deadlines, penalties, grading criteria, allowed/disallowed materials, required format, submission rules, or assessment conditions.

### 3. Research Evidence Mode

Use for research papers, multiple readings, literature review, proposal support, theory/method comparison, citation support, source synthesis, or micro-research.

Do not immediately read every paper when many sources exist.

1. Build a source inventory first:
   - filename/title,
   - type,
   - author/year if visible,
   - topic hints,
   - parsed/indexed status.
2. Use RAG to identify candidate papers and clusters around the user's research question.
3. Start with top candidates:
   - user-specified core papers,
   - repeated RAG hits,
   - review/meta/theory papers,
   - clearly relevant titles,
   - recent or authoritative sources when metadata is available.
4. Read in layers:
   - for 1-3 likely papers or short reports, read the complete parsed Markdown first,
   - for many papers, first pass: abstract, introduction, conclusion, headings, methods summary,
   - second pass: full relevant sections for top papers,
   - third pass: tables, figures, appendix, limitations, or measures only when needed.
5. Build an evidence matrix before writing synthesis when multiple papers are involved:
   - file/title,
   - research question,
   - theory/framework,
   - method/data/sample,
   - key findings,
   - limitations,
   - relevance to the user's topic,
   - useful citation/location,
   - contradictions or support relationships.
6. Only after evidence mapping should you draft a literature review, proposal, report, or presentation narrative.

### 4. Data Evidence Mode

Use for XLSX, CSV, TSV, SPSS-like exports, tables, variables, formulas, charts, reusable data, or data-to-report tasks.

1. Resolve candidate data files by filename/type and RAG if needed.
2. Use spreadsheet readers or structured artifacts, not plain text guesses.
3. Cite sheet names, table names, ranges, variables, formulas, and chart titles when available.
4. Preserve exact `semanticUnitId` and `elementIds` metadata for chart or shape hits so Brevyn can reopen the precise preview object; never synthesize these ids.
5. For report/PPT reuse, identify reusable tables, charts, computed results, and limitations before generating narrative.
6. If formulas, charts, hidden sheets, merged cells, comments, or data validation matter, use source reading or the spreadsheet skill before final claims.

### 5. Material Reuse Mode

Use when turning existing materials into PPT, reports, outlines, study notes, or presentation plans.

1. Identify the user's target output and audience.
2. Locate source candidates with file metadata and RAG.
3. Read key source files before planning. For a small source set, read the complete parsed Markdown, then use artifacts/semantic units to verify figures, tables, charts, formulas, speaker notes, and source locations.
4. Extract reusable assets:
   - claims and conclusions,
   - figures and model diagrams,
   - tables and data results,
   - methods or workflow steps,
   - citations and source locations,
   - speaker notes or slide structure when present.
5. Return a plan and source-material checklist before generating a final deliverable when the task is substantial.

## Many-File Rule

When many files exist, do not read every source file first.

Use this progression:

1. Metadata filter.
2. RAG candidate search.
3. Read top 1-3 source files. Prefer complete `read_parsed_file` reads for these files when parsed Markdown exists.
4. Expand to top 5 if needed.
5. Read all files only when the user explicitly asks for exhaustive or full-course/global scanning.

Suggested scale:

- Fewer than 5 files: reading all key files may be reasonable.
- 5-20 files: rank with metadata and RAG, then read top 5-8 only if the task requires synthesis.
- More than 20 files: cluster or group first; read representative sources and ask/confirm before expanding when possible.

## Fallbacks

If source reading fails:

1. Use parsed Markdown as the default readable source when it exists.
2. Use semantic units or artifact paths to verify exact object-level evidence: tables, charts, formulas, speaker notes, images, pages, slides, ranges, comments, footnotes, and tracked changes.
3. Say when the answer is based on parsed cache rather than a fresh source-file extraction.
4. If parsed cache is missing, empty, stale, or visibly incomplete, request or run parsing before making strong claims.
5. Never pretend to have read binary Office/PDF content when only metadata was available.

## Answer Standard

Ground final answers in source evidence.

- Cite filenames.
- Include page, slide, sheet/range, section, heading, or table name when available.
- Separate verified source facts from RAG leads.
- For requirements, rubrics, deadlines, penalties, academic-integrity rules, and allowed/disallowed materials, verify before finalizing.
- For research synthesis, distinguish what each source says from your cross-source interpretation.
- For uncertainty, say exactly what was searched, what was read, and what remains unverified.
