// Reading one page of someone's website for an import, and making it safe to serve as part of an app.
// Scripts, forms and anything that runs code are taken out (forms are listed so they can be rebuilt),
// links within the site become paths, and pictures and stylesheets are noted so Grove can copy them.
// Imported pages are also served with a policy that lets no script run, so this isn't the only guard.
import { createHash } from "node:crypto";
import { parseDocument } from "htmlparser2";
import render from "dom-serializer";
import { Element, Text, type ChildNode, type Document } from "domhandler";

/** Where an asset (a picture or stylesheet) goes in the page until Grove knows its new address. */
export const ASSET = (n: number) => `grove-asset:${n}`;
export const ASSET_RE = /grove-asset:(\d+)/g;

/** Embeds that are fine to keep: video, maps and music players, each in its own sandbox. */
export const EMBEDS = ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "player.vimeo.com", "www.google.com", "maps.google.com", "open.spotify.com", "w.soundcloud.com", "calendar.google.com", "docs.google.com"];
const embedOk = (u: URL) => EMBEDS.includes(u.hostname) && (u.hostname !== "www.google.com" || u.pathname.startsWith("/maps"));

const DROP = new Set(["script", "noscript", "template", "object", "embed", "applet", "base", "meta", "link", "title", "frame", "frameset", "portal", "dialog", "head"]);
const CONTROLS = new Set(["input", "select", "textarea", "button", "option", "datalist", "output", "fieldset", "legend"]);
const URL_ATTRS = new Set(["href", "src", "poster", "action", "formaction", "xlink:href", "cite", "background", "data", "ping"]);
const IMAGE_TYPES = /\.(png|jpe?g|gif|webp)(\?|$)/i;

export type Form = { fields: { name: string; type: string; label?: string; required?: boolean; options?: string[] }[]; submit?: string; action?: string };
export type Read = {
  title: string; description: string; lang?: string; bodyClass?: string; image?: string;
  body: string; links: string[]; forms: Form[]; styles: string[]; platform?: string; removed: string[];
};

export type Assets = { add(url: string, kind: "image" | "style"): string };

/** What made the site, from what it says about itself. */
export function platformOf(html: string, host: string) {
  const gen = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator/i)?.[1] ?? "";
  const known: [RegExp, string][] = [
    [/wordpress/i, "WordPress"], [/wix\.com/i, "Wix"], [/squarespace/i, "Squarespace"], [/webflow/i, "Webflow"], [/shopify/i, "Shopify"],
    [/ghost/i, "Ghost"], [/joomla/i, "Joomla"], [/drupal/i, "Drupal"], [/weebly/i, "Weebly"], [/godaddy|websitebuilder/i, "GoDaddy"], [/hugo/i, "Hugo"], [/jekyll/i, "Jekyll"], [/framer/i, "Framer"], [/carrd/i, "Carrd"],
  ];
  for (const [re, name] of known) if (re.test(gen)) return name;
  if (/wp-content\/|wp-includes\//.test(html)) return "WordPress";
  if (/static\.wixstatic\.com|wix-bolt|_wixCIDX/.test(html)) return "Wix";
  if (/static1\.squarespace\.com|squarespace-cdn/.test(html)) return "Squarespace";
  if (/cdn\.shopify\.com/.test(html)) return "Shopify";
  if (/assets\.website-files\.com|webflow/.test(html)) return "Webflow";
  if (/^linktr\.ee$/.test(host)) return "Linktree";
  return gen || undefined;
}

const attr = (e: Element, name: string) => e.attribs[name];
const text = (nodes: ChildNode[]): string => nodes.map((n) => (n instanceof Text ? n.data : n instanceof Element ? text(n.children) : "")).join("");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The address a link on the page means, or undefined for ones that aren't web addresses. */
function resolve(raw: string | undefined, base: URL) {
  if (!raw) return undefined;
  const v = raw.trim();
  if (!v || /^(javascript|vbscript|data|blob|file|about):/i.test(v.replace(/[\s\x00-\x1f]/g, ""))) return undefined;
  try {
    return new URL(v, base);
  } catch {
    return undefined;
  }
}

/** Same site: the same host, give or take "www.". */
export const sameSite = (u: URL, host: string) => u.hostname.replace(/^www\./, "") === host.replace(/^www\./, "");

/** A page's path as Grove keys it: no trailing slash (except "/"), no ".html". */
export const pagePath = (u: URL) => {
  let p = decodeURIComponent(u.pathname).replace(/\/index\.(html?|php)$/i, "/").replace(/\.html?$/i, "");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
};

/** Rewrites url(...) inside CSS: each picture becomes an asset, everything else an absolute address. */
export function cssUrls(css: string, base: URL, assets?: Assets) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _q, raw) => {
    const u = resolve(raw, base);
    if (!u) return /^data:image\//i.test(raw.trim()) ? whole : "url()";
    return `url("${assets && IMAGE_TYPES.test(u.pathname) ? assets.add(u.href, "image") : u.href}")`;
  }).replace(/@import\s+(url\()?\s*['"]?([^'");]+)['"]?\)?\s*;?/gi, (_w, _u, raw) => {
    const u = resolve(raw, base);
    return u ? `@import url("${assets ? assets.add(u.href, "style") : u.href}");` : "";
  }).replace(/expression\s*\(|behavior\s*:|-moz-binding/gi, "");
}

const srcset = (v: string, base: URL, assets: Assets) =>
  v.split(",").map((part) => {
    const [raw, size] = part.trim().split(/\s+/, 2);
    const u = resolve(raw, base);
    return u ? `${IMAGE_TYPES.test(u.pathname) || /wixstatic|squarespace-cdn|wp-content/.test(u.href) ? assets.add(u.href, "image") : u.href}${size ? " " + size : ""}` : "";
  }).filter(Boolean).join(", ");

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * One page, read and cleaned. `styles` are the stylesheets (as asset placeholders) and inline style
 * blocks (as "inline:<id>", with the CSS in `inlineCss`), in the order the page has them.
 */
export function readPage(html: string, pageUrl: string, inlineCss: Map<string, string>, assets: Assets): Read {
  const base0 = new URL(pageUrl);
  const doc: Document = parseDocument(html, { decodeEntities: true });
  const all = (nodes: ChildNode[], f: (e: Element) => void) => nodes.forEach((n) => n instanceof Element && (f(n), all(n.children, f)));
  let base = base0, title = "", description = "", lang: string | undefined, bodyClass: string | undefined, image: string | undefined, body: Element | undefined;
  const styles: string[] = [];
  all(doc.children, (e) => {
    const name = e.name.toLowerCase();
    if (name === "base" && attr(e, "href")) base = resolve(attr(e, "href"), base0) ?? base0;
    if (name === "html") lang = attr(e, "lang");
    if (name === "body" && !body) (body = e), (bodyClass = attr(e, "class"));
    if (name === "title" && !title) title = squash(text(e.children));
    if (name === "meta") {
      const key = (attr(e, "name") ?? attr(e, "property") ?? "").toLowerCase();
      if (key === "description" && !description) description = squash(attr(e, "content") ?? "");
      if (key === "og:image" && !image) image = resolve(attr(e, "content"), base)?.href;
    }
  });
  // Stylesheets and style blocks, anywhere on the page, in order.
  all(doc.children, (e) => {
    const name = e.name.toLowerCase();
    if (name === "link" && /\bstylesheet\b/i.test(attr(e, "rel") ?? "") && !/print/i.test(attr(e, "media") ?? "")) {
      const u = resolve(attr(e, "href"), base);
      if (u) styles.push(/fonts\.googleapis\.com|use\.typekit\.net|fonts\.bunny\.net/.test(u.hostname) ? u.href : assets.add(u.href, "style"));
    }
    if (name === "style") {
      const css = cssUrls(text(e.children), base, assets);
      if (css.trim()) {
        const id = hash(css);
        inlineCss.set(id, css);
        styles.push(`inline:${id}`);
      }
    }
  });

  const links = new Set<string>(), forms: Form[] = [], removed = new Set<string>();
  const clean = (nodes: ChildNode[]): ChildNode[] =>
    nodes.flatMap((n): ChildNode[] => {
      if (n.type === "comment" || n.type === "directive" || n.type === "cdata") return [];
      if (!(n instanceof Element)) return [n];
      const name = n.name.toLowerCase();
      if (name === "style") return [];
      if (DROP.has(name)) {
        if (name === "script" || name === "object" || name === "embed") removed.add(name === "script" ? "scripts" : "plugins");
        return [];
      }
      if (name === "form") {
        forms.push(formOf(n));
        removed.add("forms");
        const holder = new Element("div", { class: "grove-form", "data-grove-form": String(forms.length) }, [new Text(`[Form ${forms.length}: rebuilt by the app]`)]);
        return [holder];
      }
      if (CONTROLS.has(name)) {
        if (name === "button") return clean(n.children);
        return [];
      }
      if (name === "iframe") {
        const u = resolve(attr(n, "src") ?? attr(n, "data-src"), base);
        if (!u || !embedOk(u)) return removed.add("embeds"), [];
        n.attribs = { src: u.href, title: attr(n, "title") ?? "Embedded content", loading: "lazy", sandbox: "allow-scripts allow-same-origin allow-popups allow-presentation", allowfullscreen: "", ...(attr(n, "width") && { width: attr(n, "width") }), ...(attr(n, "height") && { height: attr(n, "height") }), ...(attr(n, "style") && { style: attr(n, "style") }), ...(attr(n, "class") && { class: attr(n, "class") }) };
        n.children = [];
        return [n];
      }
      // Pictures that only load with the page's scripts: use the address they'd have loaded.
      for (const lazy of ["data-src", "data-lazy-src", "data-original", "data-image"]) if (attr(n, lazy) && (!attr(n, "src") || /^data:/.test(attr(n, "src")))) n.attribs.src = attr(n, lazy);
      for (const lazy of ["data-srcset", "data-lazy-srcset"]) if (attr(n, lazy) && !attr(n, "srcset")) n.attribs.srcset = attr(n, lazy);
      const out: Record<string, string> = {};
      for (const [k0, v] of Object.entries(n.attribs)) {
        const k = k0.toLowerCase();
        if (k.startsWith("on") || k === "srcdoc" || k === "formaction" || k === "action" || k === "ping" || k === "is" || k.startsWith("xmlns:") && /script/i.test(v)) continue;
        if (k === "style") {
          out.style = cssUrls(v, base, assets);
          continue;
        }
        if (k === "srcset") {
          out.srcset = srcset(v, base, assets);
          continue;
        }
        if (URL_ATTRS.has(k)) {
          const u = resolve(v, base);
          if (!u) {
            if (k === "src" && /^data:image\/(png|jpe?g|gif|webp);/i.test(v.trim())) out[k] = v.trim();
            else if (k === "href" && /^(#|mailto:|tel:|sms:)/i.test(v.trim())) out[k] = v.trim();
            continue;
          }
          if (k === "href" && name === "a") {
            if (sameSite(u, base0.hostname) && (u.protocol === "https:" || u.protocol === "http:")) {
              const p = pagePath(u);
              if (!/\.(pdf|jpe?g|png|gif|webp|zip|docx?|xlsx?|mp3|mp4)$/i.test(p)) {
                links.add(p);
                out.href = p + u.hash;
                continue;
              }
            }
            out.href = u.href;
            out.rel = "noopener";
            continue;
          }
          if ((name === "img" || name === "source" || k === "poster" || k === "background") && k !== "href") {
            out[k] = IMAGE_TYPES.test(u.pathname) || /wixstatic|squarespace-cdn|wp-content|ctfassets|cloudinary/.test(u.href) ? assets.add(u.href, "image") : u.href;
            continue;
          }
          out[k] = u.href;
          continue;
        }
        out[k0] = v;
      }
      n.attribs = out;
      n.children = clean(n.children);
      // SVG can carry scripts of its own and links that run code; only keep plain drawing.
      if (name === "svg") all(n.children, (c) => { for (const k of Object.keys(c.attribs)) if (k.toLowerCase().startsWith("on") || (/href$/i.test(k) && /^\s*javascript:/i.test(c.attribs[k]))) delete c.attribs[k]; });
      return [n];
    });

  const root = body ?? doc;
  const cleaned = clean(root.children);
  if (/<script[\s>]/i.test(html)) removed.add("scripts");
  return {
    title: title || base0.hostname,
    description,
    lang,
    bodyClass,
    image,
    // Line breaks and indents between tags are most of a page's size on some site builders.
    body: render(cleaned, { decodeEntities: true, encodeEntities: "utf8" }).replace(/>\s*\n\s*</g, ">\n<").trim(),
    links: [...links],
    forms,
    styles,
    platform: platformOf(html, base0.hostname),
    removed: [...removed],
  };
}

/** What a form asked for, so it can be built again as a page and a table. */
function formOf(form: Element): Form {
  const fields: Form["fields"] = [];
  const labels = new Map<string, string>();
  const walk = (nodes: ChildNode[], f: (e: Element) => void) => nodes.forEach((n) => n instanceof Element && (f(n), walk(n.children, f)));
  walk(form.children, (e) => {
    if (e.name === "label" && e.attribs.for) labels.set(e.attribs.for, squash(text(e.children)));
  });
  let submit: string | undefined;
  walk(form.children, (e) => {
    const type = (e.attribs.type ?? (e.name === "input" ? "text" : e.name)).toLowerCase();
    if (e.name === "button" || (e.name === "input" && type === "submit")) return void (submit ??= squash(e.attribs.value ?? text(e.children)) || undefined);
    if (!["input", "select", "textarea"].includes(e.name) || ["hidden", "submit", "image", "reset", "button"].includes(type)) return;
    const name = e.attribs.name ?? e.attribs.id ?? `field${fields.length + 1}`;
    fields.push({
      name: name.slice(0, 80),
      type: e.name === "input" ? type : e.name,
      label: (labels.get(e.attribs.id ?? "") ?? e.attribs["aria-label"] ?? e.attribs.placeholder)?.slice(0, 200) || undefined,
      ...(e.attribs.required !== undefined && { required: true }),
      ...(e.name === "select" && { options: e.children.filter((o): o is Element => o instanceof Element && o.name === "option").map((o) => squash(text(o.children))).slice(0, 50) }),
    });
  });
  return { fields: fields.slice(0, 40), submit, action: form.attribs.action?.slice(0, 300) };
}

/** Plain words of a page, for checking what it is about without keeping it. */
export const wordsOf = (html: string) => squash(html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " "));
