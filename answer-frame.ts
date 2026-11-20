/** Builds the sandboxed frame document for an HTML answer, and reads the links it reports. Same as frame.ts in the Answer Panel plugin. */

export const FRAME_MESSAGE = "feed-answer-frame";

/** What the frame reports to its parent. */
export type FrameMessage =
  | { source: typeof FRAME_MESSAGE; kind: "link"; href: string }
  | { source: typeof FRAME_MESSAGE; kind: "scroll"; y: number };

/** Where a link in an answer points. */
export type LinkTarget =
  | { kind: "url"; url: string }
  | { kind: "thread"; threadId: string }
  | { kind: "host-file"; path: string }
  | { kind: "storage-file"; path: string };

/** Styles plain semantic HTML in BB's theme; an answer's own CSS comes later and wins. */
const BASE_CSS = `
html{color-scheme:light dark}
body{margin:0;padding:16px;color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;line-height:1.55}
h1,h2,h3,h4{line-height:1.3;margin:1.2em 0 .5em;font-weight:600}
h1{font-size:1.35em}h2{font-size:1.15em}h3{font-size:1em}
body>:first-child{margin-top:0}
p,ul,ol,table,pre{margin:.6em 0}
ul,ol{padding-left:1.4em}li{margin:.25em 0}
hr{border:0;border-top:1px solid var(--border);margin:1.4em 0}
a{color:var(--primary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
code{font-family:var(--font-mono,ui-monospace,monospace);font-size:.9em;background:var(--muted);border-radius:4px;padding:.1em .3em}
pre{background:var(--muted);border-radius:var(--radius,6px);padding:10px 12px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;font-size:.95em}
th,td{border:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top}
th{background:var(--muted);font-weight:600}
blockquote{margin:.6em 0;padding-left:12px;border-left:3px solid var(--border);color:var(--muted-foreground)}
img,svg{max-width:100%}
`;

/** Reports link clicks and the scroll position to the parent, and restores the scroll position. */
function frameScript(scrollY: number): string {
  return `(()=>{
const S=${JSON.stringify(FRAME_MESSAGE)};
document.addEventListener("click",(e)=>{
  const a=e.target instanceof Element?e.target.closest("a[href]"):null;
  if(!a)return;
  const href=a.getAttribute("href")||"";
  if(href.startsWith("#"))return;
  e.preventDefault();
  parent.postMessage({source:S,kind:"link",href},"*");
},true);
let t;
addEventListener("scroll",()=>{clearTimeout(t);t=setTimeout(()=>parent.postMessage({source:S,kind:"scroll",y:scrollY},"*"),100)});
addEventListener("load",()=>scrollTo(0,${Math.max(0, Math.round(scrollY))}));
})();`;
}

/** bb's theme custom properties, so an answer can use var(--foreground) and the like. */
function themeCss(): string {
  const style = getComputedStyle(document.documentElement);
  const vars: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith("--")) vars.push(`${name}:${style.getPropertyValue(name)};`);
  }
  return `:root{${vars.join("")}}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function buildSrcDoc(content: string, baseUrl: string, scrollY: number): string {
  const base = new URL(baseUrl, window.location.href).href;
  const head = [
    `<base href="${escapeAttribute(base)}">`,
    `<style>${themeCss()}${BASE_CSS}</style>`,
    `<script>${frameScript(scrollY)}<\/script>`,
  ].join("");
  const match = /<head(\s[^>]*)?>/i.exec(content);
  if (match) {
    const at = match.index + match[0].length;
    return content.slice(0, at) + head + content.slice(at);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${content}</body></html>`;
}

export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.source !== FRAME_MESSAGE) return null;
  if (message.kind === "link" && typeof message.href === "string") {
    return { source: FRAME_MESSAGE, kind: "link", href: message.href };
  }
  if (message.kind === "scroll" && typeof message.y === "number" && Number.isFinite(message.y)) {
    return { source: FRAME_MESSAGE, kind: "scroll", y: message.y };
  }
  return null;
}

/**
 * Link forms an answer can use: an http(s) URL, `thread:<id>` (also `@thread:<id>`),
 * an absolute file path on the thread's machine, or a path relative to the thread's storage folder.
 */
export function resolveLink(href: string): LinkTarget | null {
  const value = href.trim();
  if (/^https?:\/\//i.test(value)) return { kind: "url", url: value };
  const thread = /^@?thread:(thr_[A-Za-z0-9_-]+)/.exec(value);
  if (thread) return { kind: "thread", threadId: thread[1]! };
  const local = value.replace(/^file:\/\//i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(local)) return null;
  const path = decodeURI(local.split("#")[0]!);
  if (path === "") return null;
  if (path.startsWith("/")) return { kind: "host-file", path };
  if (path.split("/").includes("..")) return null;
  return { kind: "storage-file", path: path.replace(/^\.\//, "") };
}
