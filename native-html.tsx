/** Renders an HTML answer as normal BB page content, with BB's own link components. Same as native-html.tsx in the Answer Panel plugin. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { UrlLink, experimental_FileLink as FileLink, useBbNavigate } from "@get-bb/plugin-sdk/app";

/** Styles plain semantic HTML in BB's theme. The answer's own CSS comes after it and wins. */
const BASE_CSS = `
color:var(--foreground);font-size:14px;line-height:1.55;overflow-wrap:anywhere;
h1,h2,h3,h4{line-height:1.3;margin:1.2em 0 .5em;font-weight:600}
h1{font-size:1.35em}h2{font-size:1.15em}h3{font-size:1em}
>:first-child{margin-top:0}
p,ul,ol,table,pre{margin:.6em 0}
ul,ol{padding-left:1.4em}ul{list-style:disc}ol{list-style:decimal}li{margin:.25em 0}
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
b,strong{font-weight:600}
`;

const REMOVED_ELEMENTS = "script,iframe,frame,object,embed,base,meta,link,noscript,template,form";

/** Where a link in an answer points. */
type LinkTarget =
  | { kind: "url"; url: string }
  | { kind: "thread"; threadId: string }
  | { kind: "host-file"; path: string }
  | { kind: "storage-file"; path: string };

/**
 * Link forms: an http(s) URL, `thread:<id>` (also `@thread:<id>`), an absolute file path
 * on the thread's machine, or a path relative to the thread's storage folder.
 */
function resolveLink(href: string): LinkTarget | null {
  const value = href.trim();
  if (/^https?:\/\//i.test(value)) return { kind: "url", url: value };
  const thread = /^@?thread:(thr_[A-Za-z0-9_-]+)/.exec(value);
  if (thread) return { kind: "thread", threadId: thread[1]! };
  const local = value.replace(/^file:\/\//i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(local)) return null;
  let path: string;
  try {
    path = decodeURI(local.split("#")[0]!);
  } catch {
    return null;
  }
  if (path === "") return null;
  if (path.startsWith("/")) return { kind: "host-file", path };
  if (path.split("/").includes("..")) return null;
  return { kind: "storage-file", path: path.replace(/^\.\//, "") };
}

interface Link {
  slot: HTMLElement;
  target: LinkTarget;
  html: string;
  title: string | null;
}

/** Parses the answer, removes active content, and returns the body, the CSS, and the links. */
function prepare(content: string, baseUrl: string): { body: HTMLElement; css: string; links: Omit<Link, "slot">[]; slots: HTMLElement[] } {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const css = Array.from(doc.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n");
  doc.querySelectorAll("style").forEach((style) => style.remove());
  doc.querySelectorAll(REMOVED_ELEMENTS).forEach((element) => element.remove());
  const base = new URL(baseUrl, window.location.href);
  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attribute.name);
      } else if (name === "src" && !/^(https?:|data:image\/)/i.test(value)) {
        element.setAttribute("src", new URL(value, base).href);
      }
    }
  }
  const links: Omit<Link, "slot">[] = [];
  const slots: HTMLElement[] = [];
  for (const anchor of Array.from(doc.body.querySelectorAll("a"))) {
    if (!(anchor instanceof HTMLAnchorElement)) continue;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    const target = resolveLink(href);
    const slot = doc.createElement("span");
    if (target === null) {
      slot.innerHTML = anchor.innerHTML;
    } else {
      links.push({ target, html: anchor.innerHTML, title: anchor.getAttribute("title") });
      slots.push(slot);
    }
    anchor.replaceWith(slot);
  }
  return { body: doc.body, css, links, slots };
}

function AnswerLink({
  link,
  threadId,
  hostId,
}: {
  link: Link;
  threadId: string;
  hostId: string;
}): ReactNode {
  const navigate = useBbNavigate();
  const children = <span dangerouslySetInnerHTML={{ __html: link.html }} />;
  const title = link.title ?? undefined;
  switch (link.target.kind) {
    case "url":
      return (
        <UrlLink href={link.target.url} title={title}>
          {children}
        </UrlLink>
      );
    case "host-file":
      return (
        <FileLink target={{ kind: "host", hostId, path: link.target.path }} title={title}>
          {children}
        </FileLink>
      );
    case "storage-file":
      return (
        <FileLink target={{ kind: "thread-storage", threadId, path: link.target.path }} title={title}>
          {children}
        </FileLink>
      );
    case "thread": {
      const target = link.target.threadId;
      return (
        <a
          href="#"
          title={title}
          onClick={(event) => {
            event.preventDefault();
            navigate.toThread(target);
          }}
        >
          {children}
        </a>
      );
    }
  }
}

export function NativeHtml({
  content,
  baseUrl,
  threadId,
  hostId,
}: {
  content: string;
  baseUrl: string;
  threadId: string;
  hostId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<Link[]>([]);

  useLayoutEffect(() => {
    const container = root.current;
    if (container === null) return;
    const { body, css, links: found, slots } = prepare(content, baseUrl);
    const style = document.createElement("style");
    // Nesting keeps the base styles and the answer's CSS inside the pane.
    style.textContent = `.answer-pane-html{${BASE_CSS}}\n.answer-pane-html{${css}}`;
    container.replaceChildren(style, ...Array.from(body.childNodes));
    setLinks(found.map((link, index) => ({ ...link, slot: slots[index]! })));
  }, [content, baseUrl]);

  // In-page links (#id) scroll inside the pane and leave BB's URL alone.
  useLayoutEffect(() => {
    const container = root.current;
    if (container === null) return;
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
      if (anchor === null || !container.contains(anchor)) return;
      event.preventDefault();
      const id = decodeURIComponent(anchor.getAttribute("href")!.slice(1));
      container.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, []);

  return (
    <>
      <div ref={root} className="answer-pane-html" />
      {links.map((link, index) =>
        createPortal(<AnswerLink link={link} threadId={threadId} hostId={hostId} />, link.slot, String(index)),
      )}
    </>
  );
}
