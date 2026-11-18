// Things an app gets with nothing for its maker to set up. Email, background work and files are real.
// Payments, text messages, AI and PDFs are pretend versions until the real ones arrive.
//
// A pretend service takes the same input and gives back the same shape the real one will, with
// `mock: true` and a note saying what did not really happen. Code written against it keeps working
// when the real service is switched on. Always tell the person when a result is pretend.

/** Added to every result from a service that is not real yet. */
export interface Pretend {
  /** True when nothing really happened: no money moved, no text was sent, no job will run. */
  mock?: true;
  /** What to tell the person about it, in plain words. */
  note?: string;
}

import type { Tasks } from "./tasks.ts";

export interface Services {
  /** Real. Plain-text email from the app, through Grove. */
  email: {
    /**
     * Sends one email to up to 10 addresses. Grove adds a line saying which app sent it. There is a daily limit
     * per app. On a trial copy only the app's own people are emailed; other addresses are held and listed in `held`.
     */
    send(msg: { to: string | string[]; subject: string; text: string; replyTo?: string }): Promise<{ sent: string[]; held: string[]; note?: string }>;
  };
  /** Pretend for now. Taking a card payment on a page Grove hosts. */
  payments: {
    /** Starts a payment. amount is in the smallest unit (pence, cents). Send the person to `url` to pay. */
    checkout(o: { amount: number; currency?: string; description: string; reference?: string; returnTo?: string }): Promise<{ id: string; url: string; status: "unpaid" } & Pretend>;
    /** Whether a payment started with checkout has been paid. */
    status(id: string): Promise<{ id: string; status: "unpaid" | "paid"; amount: number; currency: string; reference?: string } & Pretend>;
  };
  /** Real. Work that happens later or on a timer, kept in the app's own database. The work itself is one of the app's `jobs`. See tasks.ts. */
  tasks: Tasks;
  /** Real. Keeping a file (a photo, a document) and getting a web address for it. Up to 4 MB each; images, PDFs, text, CSV, Word and Excel. */
  files: {
    /** Keeps a file. With public true anyone with the address can open it; otherwise `url` is a private link that works for an hour. */
    put(file: { name: string; type: string; base64: string; public?: boolean }): Promise<{ id: string; url: string; bytes: number; public?: boolean } & Pretend>;
    /** A fresh link to a file kept earlier. For a private file it works for `minutes` (an hour unless said, a week at most). */
    link(id: string, o?: { minutes?: number }): Promise<{ id: string; url: string } & Pretend>;
    remove(id: string): Promise<{ id: string; removed: boolean } & Pretend>;
  };
  /** Pretend for now. Text messages to phones. */
  texts: {
    send(msg: { to: string; text: string }): Promise<{ id: string; to: string } & Pretend>;
  };
  /** Pretend for now. Asking an AI model from inside the app, e.g. to sort or summarise what people typed. */
  ai: {
    ask(q: { prompt: string; instructions?: string }): Promise<{ text: string } & Pretend>;
  };
  /** Pretend for now. Turning a page into a PDF, e.g. an invoice or a certificate. */
  pdf: {
    make(doc: { title: string; html: string }): Promise<{ id: string; url: string } & Pretend>;
  };
}

/** What each service is, and whether it is real yet. Grove's own list is the one to trust; this is for apps run elsewhere. */
export const SERVICE_LIST = [
  { name: "email", real: true, what: "Confirmations, reminders and notices, sent from your app." },
  { name: "payments", real: false, what: "Take a card payment on a page Grove hosts. No payment account to open." },
  { name: "tasks", real: true, what: "Do something later, or every morning, without anyone asking." },
  { name: "files", real: true, what: "Keep uploads and photos, each with its own web address." },
  { name: "texts", real: false, what: "Send a text to a phone." },
  { name: "ai", real: false, what: "Sort, summarise or draft from what people typed." },
  { name: "pdf", real: false, what: "Invoices, certificates and anything to print." },
] as const;

/**
 * The services for one app. With Grove's address and the app's secret, calls go to Grove. Without
 * them (an app run somewhere else) email goes through `emailDirect` if the app has one, and the
 * rest give a pretend result saying they need setting up.
 */
export function createServices(o: { grove?: string; secret?: string; trial?: boolean; emailDirect?: (to: string[], subject: string, text: string, replyTo?: string) => Promise<boolean>; tasks?: Tasks }): Services {
  const call = async (service: string, action: string, body: unknown): Promise<any> => {
    if (!o.grove || !o.secret) {
      if (service === "email") {
        const m = body as { to: string | string[]; subject: string; text: string; replyTo?: string };
        const to = [m.to].flat();
        if (!o.emailDirect) throw new Error("Email isn't set up for this app.");
        const ok = await o.emailDirect(to, m.subject, m.text, m.replyTo);
        if (!ok) throw new Error("The email could not be sent.");
        return { sent: to, held: [] };
      }
      return { id: `local-${Date.now()}`, mock: true, note: `Pretend: this app isn't run by Grove, so ${service} needs setting up by whoever runs it.`, ...(body as object) };
    }
    const res = await fetch(`${o.grove}/services/${service}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.secret}` },
      body: JSON.stringify({ ...(body as object), trial: Boolean(o.trial) }),
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `Grove's ${service} service answered ${res.status}.`);
    return out;
  };
  return {
    email: { send: (msg) => call("email", "send", msg) },
    payments: { checkout: (x) => call("payments", "checkout", x), status: (id) => call("payments", "status", { id }) },
    tasks: o.tasks ?? {
      later: () => Promise.reject(new Error("Background work isn't set up for this app.")),
      every: () => Promise.reject(new Error("Background work isn't set up for this app.")),
      cancel: () => Promise.reject(new Error("Background work isn't set up for this app.")),
    },
    files: { put: (file) => call("files", "put", file), link: (id, o) => call("files", "link", { id, ...o }), remove: (id) => call("files", "remove", { id }) },
    texts: { send: (msg) => call("texts", "send", msg) },
    ai: { ask: (q) => call("ai", "ask", q) },
    pdf: { make: (doc) => call("pdf", "make", doc) },
  };
}
