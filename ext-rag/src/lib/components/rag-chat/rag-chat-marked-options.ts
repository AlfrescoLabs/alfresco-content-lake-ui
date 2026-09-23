import { MarkedOptions } from 'ngx-markdown';
import { Renderer, Tokens } from 'marked';

/**
 * How a generated answer's markdown is rendered.
 *
 * A link in an answer points somewhere outside the current view, so it opens in a new tab with
 * `rel="noopener noreferrer"` rather than replacing the application. This matches what ACA's own AI
 * results view does, so the two behave the same way inside the same shell.
 *
 * `Renderer` comes straight from marked, because that is precisely what this file used to get: ngx-markdown's
 * `MarkedRenderer` was `export { Renderer as MarkedRenderer } from 'marked'`, and version 19 stopped
 * re-exporting it. Importing the original is therefore the migration that changes no behaviour.
 *
 * Deliberately **not** ngx-markdown's `ExtendedRenderer`, which the compiler's error message offers as the
 * replacement. That is ngx-markdown's own subclass, and it carries two marker properties it uses to record
 * whether it has already extended a renderer for extensions and for mermaid. Constructing one here would leave
 * those undefined, which is a semantic change, and it makes the object unusable with marked's own
 * `use({ renderer })` because that validates every key against the known renderer methods. Handing over a plain
 * `Renderer` lets ngx-markdown extend it as it expects to.
 *
 * `Tokens` comes from the package root rather than `marked/lib/marked`. The internal path still resolves for
 * TypeScript by filename fallback, but marked 15's exports map does not list it, so it is a private path that
 * happens to work rather than a supported one.
 */
const renderer = new Renderer();

renderer.link = ({ href, title, text }: Tokens.Link): string =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${title || ''}">${text}</a>`;

export const ragChatMarkedOptions: MarkedOptions = {
  renderer
};
