// A watermark that says "automation sent this".
//
// The loop guard originally matched on CONTENT: remember what we sent, drop an
// incoming message that looks the same. That works, but it is a guess in both
// directions — a human retyping the same sentence within the window gets
// dropped, and an app that truncates the text ("…") slips through.
//
// So every message automation sends carries an invisible stamp, and an incoming
// message carrying it is OURS, with certainty. Content matching stays as the
// fallback for anything that strips the characters.
//
// The stamp is a run of zero-width codepoints:
//   U+2060 WORD JOINER · U+200B ZWSP · U+200C ZWNJ · U+200D ZWJ · U+2060
// Invisible in every chat client, survives copy/paste, and cannot appear in
// normal typing. Deliberately NOT `\s`-class: JS `\s` does not match U+200B, so
// the whitespace normalisation used everywhere else leaves it intact.

/**
 * Built from CHARACTER CODES, never typed as the characters themselves.
 *
 * A source file holding invisible codepoints is one prettier run, one editor
 * "trim whitespace" or one git filter away from becoming an EMPTY string — and
 * an empty needle makes `includes()` true for everything, which would classify
 * every incoming message as our own echo and kill the trigger completely. Even
 * `'\\u2060'` escapes are not safe here: a tool that "normalises" the file can
 * fold them back into the raw characters. Character codes stay ASCII.
 */
export const ECHO_MARK = String.fromCharCode(0x2060, 0x200b, 0x200c, 0x200d, 0x2060);

/** Append the stamp. Kept at the END so the first line reads unchanged. */
export const stampText = (text: string): string => `${text ?? ''}${ECHO_MARK}`;

/** Did automation send this? Never true on an empty mark — see above. */
export const hasMark = (text: string): boolean =>
  ECHO_MARK.length > 0 && (text ?? '').includes(ECHO_MARK);

/**
 * Remove the stamp. Used before anything is DISPLAYED or written to a log:
 * invisible characters that survive into a copied bug report are their own kind
 * of confusing.
 */
export const stripMark = (text: string): string =>
  ECHO_MARK.length > 0 ? (text ?? '').split(ECHO_MARK).join('') : (text ?? '');
