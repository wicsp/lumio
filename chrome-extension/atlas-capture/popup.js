const BRIDGE_URL = "http://127.0.0.1:43119/capture";

function extractCurrentPage() {
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  const candidates = [
    ...document.querySelectorAll("article, main, [role='main']"),
  ].filter((element) => element instanceof HTMLElement);
  const root = candidates
    .map((element) => ({ element, score: (element.innerText || "").trim().length }))
    .sort((a, b) => b.score - a.score)[0]?.element || document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll([
    "script", "style", "noscript", "template", "nav", "aside", "footer", "form",
    "dialog", "button", "input", "select", "textarea", "canvas", "svg", "video",
    "audio", "iframe", "[aria-hidden='true']", "[hidden]",
  ].join(",")).forEach((element) => element.remove());

  const escapeText = (value) => value
    .replace(/\\/g, "\\\\")
    .replace(/([*_[\]`])/g, "\\$1")
    .replace(/[ \t\f\v]+/g, " ");
  const renderChildren = (node) => Array.from(node.childNodes).map(render).join("");
  const render = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue || "");
    if (!(node instanceof HTMLElement)) return "";
    const tag = node.tagName.toLowerCase();
    const content = renderChildren(node).trim();
    if (!content && tag !== "img" && tag !== "br") return "";
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${content}\n\n`;
    if (tag === "p" || tag === "section" || tag === "article") return `\n\n${content}\n\n`;
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return `**${content}**`;
    if (tag === "em" || tag === "i") return `*${content}*`;
    if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return `\`${content}\``;
    if (tag === "pre") return `\n\n\`\`\`\n${node.innerText.trim()}\n\`\`\`\n\n`;
    if (tag === "blockquote") return `\n\n${content.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    if (tag === "li") return `\n- ${content}`;
    if (tag === "ul" || tag === "ol") return `\n${content}\n`;
    if (tag === "a") {
      const href = node.getAttribute("href");
      if (!href || href.startsWith("javascript:")) return content;
      try { return `[${content}](${new URL(href, location.href).href})`; } catch { return content; }
    }
    if (tag === "img") {
      const alt = (node.getAttribute("alt") || "").trim();
      const src = node.getAttribute("src");
      if (!alt || !src) return "";
      try { return `![${escapeText(alt)}](${new URL(src, location.href).href})`; } catch { return ""; }
    }
    if (tag === "tr") return `\n${content}\n`;
    if (tag === "th" || tag === "td") return ` | ${content}`;
    return content;
  };

  const markdown = render(clone)
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    url: canonical,
    title: document.title.trim() || location.hostname,
    markdown,
    captured_at: new Date().toISOString(),
  };
}

const button = document.querySelector("#send");
const status = document.querySelector("#status");

button.addEventListener("click", async () => {
  button.disabled = true;
  status.dataset.kind = "";
  status.textContent = "Extracting page…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractCurrentPage,
    });
    if (!result?.markdown) throw new Error("No readable page content found");
    status.textContent = "Sending to Atlas…";
    const response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lumio-Capture": "1" },
      body: JSON.stringify(result),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Bridge returned ${response.status}`);
    status.textContent = "Queued for summary.";
  } catch (error) {
    status.dataset.kind = "error";
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
});
