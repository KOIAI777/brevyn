---
name: xlsx
description: "Use this skill when a spreadsheet is the primary source or deliverable. Trigger for XLSX/XLSM workbooks and CSV/TSV data tables when the user asks to read, analyze, cite, inspect, clean, summarize, visualize, or create tabular data, including formulas, tables, charts, comments, named ranges, and sheet/range evidence. In Brevyn course/task workspaces, prefer the parsed office artifact and semantic units before opening the original file. CSV/TSV support is a lightweight single-sheet table workflow: use it for structured reading, citations, cleaning plans, and conversion to XLSX; do not assume formulas, charts, styles, comments, or named ranges exist in CSV/TSV. Do NOT use for Word/PDF/PPT deliverables, standalone scripts, database pipelines, or Google Sheets API integrations."
license: Proprietary. LICENSE.txt has complete terms
version: "2.3.0"
---

# Spreadsheet skill

Use this skill for spreadsheet work in three modes:

1. **Read/analyze/cite an existing workbook** from Brevyn course materials, task materials, uploads, or an attached file.
2. **Read/analyze/cite CSV/TSV tables** as a lightweight single-sheet workbook.
3. **Create/edit/export a workbook** with formulas, formatting, tables, charts, and formula verification.

CSV/TSV files are treated as a single sheet named `CSV` or `TSV`. They can provide table/range citations and structured rows/cells, but they do not carry native Excel formulas, charts, styles, comments, or named ranges unless converted into an XLSX workbook.

## Brevyn Office Authoring Protocol

Use this protocol before choosing a lower-level spreadsheet technique.

### Runtime gate

- In Brevyn, call `office_runtime` with `prepare=true` before the first formula recalculation, LibreOffice conversion, or visual QA operation in a run.
- Use `selfTest=true` when recalculation/conversion previously failed or the runtime may be damaged, then retry the shared preflight.
- Do not ask the user to install LibreOffice while the bundled runtime reports `ready` or `available`.

### Route the task

- **Read or answer from an existing workbook/table**: resolve the Brevyn file record, then read parsed Markdown for a human-readable overview when useful. Use semantic units and the office artifact to inspect sheets, tables, formulas, charts, comments, named ranges, and source ranges.
- **Analyze data**: preserve typed values. Use formulas or auditable calculations for derived results; state whether the result came from workbook formulas or your own computation.
- **Edit an existing workbook**: preserve existing sheet structure, formulas, named ranges, table styles, chart ranges, and formatting unless the user asks for redesign.
- **Create a new workbook**: design inputs, assumptions, calculations, outputs, charts, and source notes as separate, auditable areas.
- **Convert CSV/TSV**: treat the source as one plain table. If the user wants formulas, styles, charts, or multiple sheets, create an XLSX output.

### Source and cache policy

- Treat the spreadsheet source file as the factual authority.
- Brevyn parsed Markdown is useful for a readable overview. `artifactPath` and `semanticUnitsPath` are the preferred source-derived surfaces for exact spreadsheet evidence.
- Use the artifact for workbook object details: formulas, charts, hidden sheets, comments, styles, merged cells, hyperlinks, named ranges, and exact sheet/range anchors.
- Use source-file parsing or spreadsheet scripts when artifacts are missing, stale, incomplete, or contradicted by the user.
- Do not answer spreadsheet questions from filename guesses, preview thumbnails, or raw text snippets when structured sheet data is available.

### Output and QA gate

Before delivering a created or edited XLSX:

1. Save the final `.xlsx` under the requested path or a clear `outputs/` path.
2. Run the shared preflight when the environment is uncertain:
   `python ../_shared/office/office_preflight.py --json`
3. Recalculate formulas when formulas are present:
   `python scripts/recalc.py output.xlsx`
4. Run the unified Office QA report:
   `python ../_shared/office/office_qa_report.py output.xlsx --json`
   Use its sheet/range/chart/table inventory plus rendered preview artifacts when layout matters.
5. Audit workbook-specific formula errors:
   `python scripts/xlsx_audit.py output.xlsx --json`
6. Inspect key ranges, formulas, tables, and chart source ranges.
7. Render or preview important sheets/charts when layout matters.
8. Fix severe defects before delivery: broken formulas, clipped headers, unreadable charts, missing source notes, wrong number formats, or charts disconnected from data.

Final response should link only the final workbook unless the user asks for QA intermediates.

## Brevyn Workspace Reading Protocol

When the workbook is already known to Brevyn as a course/task file or upload, use Brevyn's structured source pipeline first.

1. **Locate the file**
   - Call `list_course_files` for course/task material discovery, or `get_file_record` when a `fileId` is available.
   - Confirm the target file by name, extension, and task/course scope before analyzing.

2. **Read overview, then verify structure**
   - If parsed Markdown is available and the task is summary/course evidence/report planning, call `read_parsed_file` and read the complete parsed overview first.
   - If the record reports `hasOfficeArtifact=true`, use `artifactPath` and `semanticUnitsPath` as the primary structured source for exact spreadsheet evidence.
   - Read `semanticUnitsPath` for tables, ranges, charts, formulas, comments, named ranges, hyperlinks, and sheet-level anchors.
   - Read `artifactPath` when you need the workbook object model: sheets, cells, styles, chart definitions, object ids, formulas, and bounding boxes.
   - For CSV/TSV, expect a single-sheet artifact with rows/cells and a table semantic unit; do not invent workbook-only objects.
   - Then call `read_parsed_file` for the readable Markdown overview if `hasParsedText=true`.

3. **Do not treat spreadsheets as unstructured text**
   - Do not repeatedly retry generic `Read` on binary `.xlsx/.xlsm` if it returns metadata or unsupported content.
   - For CSV/TSV, prefer the parsed artifact/semantic units over ad hoc line-by-line reading when Brevyn has already indexed the file.
   - Do not answer from filename guesses, preview thumbnails, or partial OCR when structured artifact data is available.

4. **Cite precisely**
   - For analytical answers, cite sheet names plus A1 ranges: `Sheet1!A1:D20`.
   - Prefer table names/ranges when available: `SalesTable (Revenue!A1:F18)`.
   - For charts, cite the chart title/object id and its source range when available.
   - For formulas, mention both the formula cell and referenced range when relevant.

5. **Preserve object-level anchors**
   - Treat `semanticUnitId` and `elementIds` returned for chart or shape hits as authoritative preview anchors.
   - Keep chart and shape evidence attached to the exact object instead of replacing it with a nearby sheet-level range.
   - Use the owning A1 range for comments, hyperlinks, tables, and named ranges when one is available.
   - Never invent an object id. Fall back to a verified sheet/range citation when exact object metadata is absent.

6. **Use the right source for the job**
   - Use semantic units for summaries, table extraction, evidence lookup, chart/table references, and source-aware answers.
   - Use artifact JSON for layout-sensitive questions, formulas, chart metadata, comments, named ranges, hyperlinks, and workbook object details.
   - Use Python/openpyxl only as a fallback when no parsed artifact exists or when creating/editing a workbook.

## XLSX Analysis Checklist

Before answering a workbook question:

- Identify workbook name and sheet(s) used.
- Inspect visible tables/ranges relevant to the question.
- Check whether formulas or calculated values are involved.
- Check whether charts, comments, named ranges, filters, or hidden sheets affect the answer.
- For comparisons or calculations, state whether you used existing workbook formulas or computed a derived result yourself.
- If the workbook is large, sample structure first, then focus on the sheet/table/range relevant to the user's question.

## CSV/TSV Rules

- Treat CSV/TSV as a plain data table, not as an Excel workbook with formulas or embedded objects.
- Cite row/table evidence with the generated sheet name and range, such as `CSV!A1:D20`.
- Preserve raw text values when interpreting identifiers, codes, percentages, and dates unless the user asks for typed conversion.
- When the user asks to clean, format, chart, or add formulas to CSV/TSV, recommend exporting or converting to XLSX first.
- If delimiter or header detection seems ambiguous, state the assumption and ask only when it materially affects the answer.

## XLSX Editing and Creation Rules

When creating or editing a workbook:

- Preserve existing workbook style, formulas, table structures, chart ranges, and sheet organization unless the user asks to redesign them.
- Use formulas for derived values instead of hardcoding results.
- Keep formula patterns consistent across rows/columns.
- Add comments for important assumptions or non-obvious calculations.
- Recalculate and scan for formula errors before delivering the file.
- Visually inspect key sheets/charts when layout matters.

## Requirements for Outputs

## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Arial, Times New Roman) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file. You have different tools and workflows available for different tasks.

## Important Requirements

**LibreOffice Required for Formula Recalculation**: You can assume LibreOffice is installed for recalculating formula values using the `scripts/recalc.py` script. The script automatically configures LibreOffice on first run, including in sandboxed environments where Unix sockets are restricted (handled by `scripts/office/soffice.py`)

## Reading and analyzing data

### Data analysis with pandas
For data analysis, visualization, and basic operations, use **pandas** which provides powerful data manipulation capabilities:

```python
import pandas as pd

# Read Excel
df = pd.read_excel('file.xlsx')  # Default: first sheet
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # All sheets as dict

# Analyze
df.head()      # Preview data
df.info()      # Column info
df.describe()  # Statistics

# Write Excel
df.to_excel('output.xlsx', index=False)
```

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
```python
# Bad: Calculating in Python and hardcoding result
total = df['Sales'].sum()
sheet['B10'] = total  # Hardcodes 5000

# Bad: Computing growth rate in Python
growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
sheet['C5'] = growth  # Hardcodes 0.15

# Bad: Python calculation for average
avg = sum(values) / len(values)
sheet['D20'] = avg  # Hardcodes 42.5
```

### ✅ CORRECT - Using Excel Formulas
```python
# Good: Let Excel calculate the sum
sheet['B10'] = '=SUM(B2:B9)'

# Good: Growth rate as Excel formula
sheet['C5'] = '=(C4-C2)/C2'

# Good: Average using Excel function
sheet['D20'] = '=AVERAGE(D2:D19)'
```

This applies to ALL calculations - totals, percentages, ratios, differences, etc. The spreadsheet should be able to recalculate when source data changes.

## Common Workflow
1. **Choose tool**: pandas for data, openpyxl for formulas/formatting
2. **Create/Load**: Create new workbook or load existing file
3. **Modify**: Add/edit data, formulas, and formatting
4. **Save**: Write to file
5. **Recalculate formulas (MANDATORY IF USING FORMULAS)**: Use the scripts/recalc.py script
   ```bash
   python scripts/recalc.py output.xlsx
   ```
6. **Verify and fix any errors**:
   - The script returns JSON with error details
   - If `status` is `errors_found`, check `error_summary` for specific error types and locations
   - Fix the identified errors and recalculate again
   - Common errors to fix:
     - `#REF!`: Invalid cell references
     - `#DIV/0!`: Division by zero
     - `#VALUE!`: Wrong data type in formula
     - `#NAME?`: Unrecognized formula name

### Creating new Excel files

```python
# Using openpyxl for formulas and formatting
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active

# Add data
sheet['A1'] = 'Hello'
sheet['B1'] = 'World'
sheet.append(['Row', 'of', 'data'])

# Add formula
sheet['B2'] = '=SUM(A1:A10)'

# Formatting
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')

# Column width
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

### Editing existing Excel files

```python
# Using openpyxl to preserve formulas and formatting
from openpyxl import load_workbook

# Load existing file
wb = load_workbook('existing.xlsx')
sheet = wb.active  # or wb['SheetName'] for specific sheet

# Working with multiple sheets
for sheet_name in wb.sheetnames:
    sheet = wb[sheet_name]
    print(f"Sheet: {sheet_name}")

# Modify cells
sheet['A1'] = 'New Value'
sheet.insert_rows(2)  # Insert row at position 2
sheet.delete_cols(3)  # Delete column 3

# Add new sheet
new_sheet = wb.create_sheet('NewSheet')
new_sheet['A1'] = 'Data'

wb.save('modified.xlsx')
```

## Recalculating formulas

Excel files created or modified by openpyxl contain formulas as strings but not calculated values. Use the provided `scripts/recalc.py` script to recalculate formulas:

```bash
python scripts/recalc.py <excel_file> [timeout_seconds]
```

Example:
```bash
python scripts/recalc.py output.xlsx 30
```

The script:
- Automatically sets up LibreOffice macro on first run
- Recalculates all formulas in all sheets
- Scans ALL cells for Excel errors (#REF!, #DIV/0!, etc.)
- Returns JSON with detailed error locations and counts
- Works on both Linux and macOS

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)

### Common Pitfalls
- [ ] **NaN handling**: Check for null values with `pd.notna()`
- [ ] **Far-right columns**: FY data often in columns 50+
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using `/` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

### Interpreting scripts/recalc.py Output
The script returns JSON with error details:
```json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,              // Total error count
  "total_formulas": 42,           // Number of formulas in file
  "error_summary": {              // Only present if errors found
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
```

## Best Practices

### Library Selection
- **pandas**: Best for data analysis, bulk operations, and simple data export
- **openpyxl**: Best for complex formatting, formulas, and Excel-specific features

### Working with openpyxl
- Cell indices are 1-based (row=1, column=1 refers to cell A1)
- Use `data_only=True` to read calculated values: `load_workbook('file.xlsx', data_only=True)`
- **Warning**: If opened with `data_only=True` and saved, formulas are replaced with values and permanently lost
- For large files: Use `read_only=True` for reading or `write_only=True` for writing
- Formulas are preserved but not evaluated - use scripts/recalc.py to update values

### Working with pandas
- Specify data types to avoid inference issues: `pd.read_excel('file.xlsx', dtype={'id': str})`
- For large files, read specific columns: `pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])`
- Handle dates properly: `pd.read_excel('file.xlsx', parse_dates=['date_column'])`

## Code Style Guidelines
**IMPORTANT**: When generating Python code for Excel operations:
- Write minimal, concise Python code without unnecessary comments
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

**For Excel files themselves**:
- Add comments to cells with complex formulas or important assumptions
- Document data sources for hardcoded values
- Include notes for key calculations and model sections
