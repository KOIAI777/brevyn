function escapeAttr(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "&#10;");
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>|])/g, "\\$1")
    .replace(/^(\s*)([#>+-])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*)(\d+)\.(?=\s)/gm, "$1$2\\.");
}

function escapeMarkdownLinkTarget(value: string): string {
  return `<${value.replace(/[<>\r\n]/g, (char) => encodeURIComponent(char))}>`;
}

function serializeInlineCode(value: string): string {
  if (!value.includes("`")) return `\`${value}\``;
  const fence = value.match(/`+/g)?.sort((a, b) => b.length - a.length)[0] ?? "`";
  const wrapper = `${fence}\``;
  return `${wrapper} ${value} ${wrapper}`;
}

function extractCodeText(codeElement: Element): string {
  const parts: string[] = [];
  for (const child of Array.from(codeElement.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.nodeValue || "");
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    parts.push(element.tagName.toLowerCase() === "br" ? "\n" : element.textContent || "");
  }
  return parts.join("");
}

export function clipboardHtmlToMarkdown(html: string, plainText: string): string {
  if (!html.trim()) return plainText;
  const normalizedHtml = html
    .replace(/<div\b[^>]*>/gi, "<p>")
    .replace(/<\/div>/gi, "</p>");
  return htmlToMarkdown(normalizedHtml).trim() || plainText;
}

export function htmlToMarkdown(html: string): string {
  if (!html || html === "<p></p>") return "";

  const container = document.createElement("div");
  container.innerHTML = html;

  function processNode(node: Node, context: "normal" | "code" = "normal"): string {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      return context === "code" ? text : escapeMarkdownText(text);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const element = node as HTMLElement;
    const tagName = element.tagName.toLowerCase();
    const childContext = tagName === "pre" || tagName === "code" ? "code" : "normal";
    const children = Array.from(element.childNodes).map((child) => processNode(child, childContext)).join("");

    switch (tagName) {
      case "div":
        if (element.getAttribute("data-type") === "raw-html-block") {
          const markdown = element.getAttribute("data-markdown");
          if (markdown !== null) return `${markdown}\n`;
          const rawHtml = element.getAttribute("data-html") || "";
          return `${rawHtml}\n`;
        }
        if (element.getAttribute("data-type") === "math-block") {
          return `$$\n${element.getAttribute("data-latex") || ""}\n$$\n`;
        }
        return children;
      case "img": {
        const src = element.getAttribute("src") || "";
        const alt = element.getAttribute("alt") || "";
        const title = element.getAttribute("title") || "";
        return `![${escapeMarkdownText(alt)}](${escapeMarkdownLinkTarget(src)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
      }
      case "video": {
        const src = element.getAttribute("src") || element.querySelector("source")?.getAttribute("src") || "";
        const title = element.getAttribute("title") || "";
        return `<video controls src="${escapeAttr(src)}"${title ? ` title="${escapeAttr(title)}"` : ""}></video>\n`;
      }
      case "p":
        return `${children}\n\n`;
      case "br":
        return "\n";
      case "strong":
      case "b":
        return `**${children}**`;
      case "em":
      case "i":
        return `*${children}*`;
      case "u":
        return `<u>${children}</u>`;
      case "s":
      case "strike":
      case "del":
        return `~~${children}~~`;
      case "code":
        if (element.parentElement?.tagName.toLowerCase() === "pre") return children;
        return serializeInlineCode(children);
      case "pre": {
        const codeElement = element.querySelector("code");
        const languageClass = codeElement?.className || "";
        const languageMatch = languageClass.match(/language-(\S+)/);
        const language = languageMatch ? languageMatch[1] : "";
        const codeContent = codeElement ? extractCodeText(codeElement) : children;
        return `\`\`\`${language}\n${codeContent}\n\`\`\`\n`;
      }
      case "a": {
        const href = element.getAttribute("href") || "";
        return `[${children}](${escapeMarkdownLinkTarget(href)})`;
      }
      case "ul":
        if (element.getAttribute("data-type") === "taskList") {
          return `${Array.from(element.children)
            .map((item) => `- [${item.getAttribute("data-checked") === "true" ? "x" : " "}] ${processNode(item).trim()}`)
            .join("\n")}\n`;
        }
        return `${Array.from(element.children).map((item) => `- ${processNode(item).trim()}`).join("\n")}\n`;
      case "ol":
        return `${Array.from(element.children).map((item, index) => `${index + 1}. ${processNode(item).trim()}`).join("\n")}\n`;
      case "li":
        return children;
      case "table": {
        const rows = Array.from(element.querySelectorAll("tr"))
          .map((row) => Array.from(row.children).map((cell) => processNode(cell).trim().replace(/\n+/g, " ")))
          .filter((row) => row.length > 0);
        if (rows.length === 0) return "";
        const columnCount = Math.max(...rows.map((row) => row.length));
        const normalize = (row: string[]) => Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
        const [head, ...body] = rows.map(normalize);
        if (!head) return "";
        return [
          `| ${head.join(" | ")} |`,
          `| ${head.map(() => "---").join(" | ")} |`,
          ...body.map((row) => `| ${row.join(" | ")} |`),
        ].join("\n") + "\n";
      }
      case "th":
      case "td":
        return children;
      case "blockquote":
        return `${children
          .replace(/\n+$/, "")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n`;
      case "h1":
        return `# ${children}\n`;
      case "h2":
        return `## ${children}\n`;
      case "h3":
        return `### ${children}\n`;
      case "h4":
        return `#### ${children}\n`;
      case "h5":
        return `##### ${children}\n`;
      case "h6":
        return `###### ${children}\n`;
      case "hr":
        return "---\n";
      case "span": {
        if (element.getAttribute("data-type") === "raw-html-inline") {
          return element.getAttribute("data-html") || "";
        }
        if (element.getAttribute("data-type") === "math-inline") {
          return `$${element.getAttribute("data-latex") || ""}$`;
        }
        const dataType = element.getAttribute("data-type");
        const dataId = element.getAttribute("data-id") || "";
        const suggestionChar = element.getAttribute("data-mention-suggestion-char") || "@";
        if (dataType === "mention") {
          if (suggestionChar === "/") return `/skill:${dataId}`;
          if (suggestionChar === "#") return `#mcp:${dataId}`;
          if (suggestionChar === "&") return `&session:${dataId}`;
          return `@file:${dataId}`;
        }
        return children;
      }
      default:
        return children;
    }
  }

  return processNode(container).trim();
}
