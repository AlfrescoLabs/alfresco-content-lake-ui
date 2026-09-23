import { Marked } from 'marked';
import { ragChatMarkedOptions } from './rag-chat-marked-options';

/**
 * What the answer renderer actually produces.
 *
 * This file had no test, which is why it went on referencing an `ngx-markdown` export that had been removed:
 * nothing exercised it, and because Karma compiles the library as one unit the breakage surfaced as every spec
 * in the bundle failing to load rather than as a failure here.
 *
 * Asserted against rendered markdown rather than by calling the renderer hook directly. The hook's signature is
 * the thing that changed between marked majors, so a test that invoked it by hand would keep passing against a
 * renderer marked no longer drives that way.
 */
describe('ragChatMarkedOptions', () => {

  function render(markdown: string): string {
    // A local Marked instance rather than the global one, so this cannot be affected by, or leak into, whatever
    // ngx-markdown has configured elsewhere in the host.
    const marked = new Marked();
    marked.use({ renderer: ragChatMarkedOptions.renderer as never });
    return marked.parse(markdown) as string;
  }

  it('opensALinkInANewTabSoAnAnswerCannotReplaceTheApplication', () => {
    const html = render('See [the policy](https://example.invalid/policy) for details.');

    expect(html).toContain('href="https://example.invalid/policy"');
    expect(html).toContain('target="_blank"');
    // Both halves matter: noreferrer withholds the referrer, and noopener is what stops the opened page
    // reaching back into this one through window.opener.
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('>the policy</a>');
  });

  it('carriesATitleWhenTheLinkHasOneAndAnEmptyOneWhenItDoesNot', () => {
    expect(render('[x](https://example.invalid "Tooltip")')).toContain('title="Tooltip"');
    // Empty rather than "null": the template interpolates `title || ''`, and a missing title reaching the DOM
    // as the string "null" is the failure this guards.
    expect(render('[x](https://example.invalid)')).toContain('title=""');
    expect(render('[x](https://example.invalid)')).not.toContain('null');
  });

  it('leavesEveryOtherMarkdownConstructToTheDefaultRenderer', () => {
    // Only the link hook is overridden, so the rest of an answer must render as marked would normally: a
    // renderer that replaced more than it meant to is the regression this catches.
    const html = render('## Heading\n\nSome **bold** and `code`.\n\n- one\n- two\n');

    expect(html).toContain('<h2');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
  });
});
